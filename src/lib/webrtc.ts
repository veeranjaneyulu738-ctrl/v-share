// ==============================================
// VIDELINK — High-Speed Multi-Channel WebRTC P2P Engine
// 4x Parallel Unordered Reliable DataChannels + Sequence Reassembly
// ==============================================

function buildIceServers(): RTCConfiguration {
  const servers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.services.mozilla.com" },
    { urls: "stun:stun.relay.metered.ca:80" },
  ];

  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  if (turnUrl) {
    servers.push({
      urls: turnUrl.split(",").map((u) => u.trim()).filter(Boolean),
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    });
  }

  return {
    iceServers: servers,
    iceCandidatePoolSize: 10,
  };
}

export const ICE_SERVERS: RTCConfiguration = buildIceServers();

// ===== Speed-Tuned Constants =====
const NUM_CHANNELS = 4;
const PACKET_CHUNK_SIZE = 64 * 1024;
const DISK_READ_BLOCK_SIZE = 4 * 1024 * 1024;
const HIGH_WATERMARK = 4 * 1024 * 1024;
const LOW_WATERMARK = 1 * 1024 * 1024;
const DISCONNECT_GRACE_MS = 6000;
const SEQ_HEADER_SIZE = 4;

export interface P2PFileMeta {
  index: number;
  name: string;
  size: number;
  mimeType: string;
}

export interface P2PProgress {
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speed: number;
  eta: number;
  currentFileIndex?: number;
  totalFiles?: number;
  currentFileName?: string;
  currentFileBytesTransferred?: number;
  currentFileTotalBytes?: number;
  currentFilePercentage?: number;
}

export type P2PStatus =
  | "initializing"
  | "waiting_for_peer"
  | "connecting"
  | "streaming"
  | "completed"
  | "cancelled"
  | "failed";

interface SignalRecord {
  id: string;
  type: string;
  from?: "sender" | "receiver";
  data?: unknown;
  timestamp: number;
}

interface StatusSignalData {
  status?: string;
  by?: "sender" | "receiver";
  reason?: string;
  attemptId?: string;
}

// ===== Signaling Helpers =====
export async function sendSignal(
  transferId: string,
  type: "offer" | "answer" | "candidate" | "status" | "cancel",
  data: unknown,
  from: "sender" | "receiver"
) {
  try {
    await fetch(`/api/transfers/${transferId}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, data, from }),
    });
  } catch (err) {
    console.warn("Signal send failed:", err);
  }
}

export async function fetchSignals(
  transferId: string,
  forRole: "sender" | "receiver",
  since: number = 0
): Promise<SignalRecord[]> {
  try {
    const res = await fetch(
      `/api/transfers/${transferId}/signal?role=${forRole}&since=${since}`
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { signals?: SignalRecord[] };
    return data.signals || [];
  } catch (err) {
    console.warn("Signal fetch failed:", err);
    return [];
  }
}

function encodeSeqHeader(seq: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = (seq >>> 24) & 0xff;
  buf[1] = (seq >>> 16) & 0xff;
  buf[2] = (seq >>> 8) & 0xff;
  buf[3] = seq & 0xff;
  return buf;
}

function decodeSeqHeader(buf: ArrayBuffer): number {
  const view = new Uint8Array(buf, 0, 4);
  return ((view[0] << 24) | (view[1] << 16) | (view[2] << 8) | view[3]) >>> 0;
}

// ==============================================
// SENDER SESSION (Multi-Channel, Multi-file & Reconnect-Safe)
// ==============================================
export class P2PSenderSession {
  private pc: RTCPeerConnection | null = null;
  private controlChannel: RTCDataChannel | null = null;
  private dataChannels: RTCDataChannel[] = [];
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private transferId: string;
  private files: File[];
  private totalBytes: number;
  private isDestroyed = false;
  private isCancelled = false;
  private isCompleted = false;
  private isStreaming = false;
  private answered = false;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSignalTime = 0;

  public onStatusChange?: (status: P2PStatus, message?: string) => void;
  public onProgress?: (progress: P2PProgress) => void;

  constructor(transferId: string, files: File | File[]) {
    this.transferId = transferId;
    this.files = Array.isArray(files) ? files : [files];
    this.totalBytes = this.files.reduce((acc, f) => acc + f.size, 0);
  }

  private clearDisconnectTimer() {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private teardownPeerConnection() {
    this.clearDisconnectTimer();
    this.pendingCandidates = [];
    if (this.controlChannel) {
      try { this.controlChannel.close(); } catch {}
      this.controlChannel = null;
    }
    for (const dc of this.dataChannels) {
      try { dc.close(); } catch {}
    }
    this.dataChannels = [];
    if (this.pc) {
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
  }

  private async setupPeerConnection(announceWaiting = true) {
    this.teardownPeerConnection();
    this.answered = false;
    this.isStreaming = false;

    const pc = new RTCPeerConnection(buildIceServers());
    this.pc = pc;

    const controlChannel = pc.createDataChannel("control", { ordered: true });
    controlChannel.binaryType = "arraybuffer";
    this.controlChannel = controlChannel;

    for (let i = 0; i < NUM_CHANNELS; i++) {
      const dc = pc.createDataChannel(`data-${i}`, { ordered: false });
      dc.binaryType = "arraybuffer";
      dc.bufferedAmountLowThreshold = LOW_WATERMARK;
      this.dataChannels.push(dc);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && this.pc === pc) {
        sendSignal(this.transferId, "candidate", event.candidate.toJSON(), "sender");
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.pc !== pc || this.isCancelled || this.isDestroyed || this.isCompleted) return;
      const state = pc.connectionState;
      if (state === "connected") {
        this.clearDisconnectTimer();
        this.onStatusChange?.("streaming", "Connected! Streaming video...");
      } else if (state === "disconnected") {
        if (!this.disconnectTimer) {
          this.disconnectTimer = setTimeout(() => {
            this.disconnectTimer = null;
            if (
              this.pc === pc &&
              !this.isCancelled &&
              !this.isDestroyed &&
              !this.isCompleted &&
              (pc.connectionState === "disconnected" || pc.connectionState === "failed")
            ) {
              this.onStatusChange?.(
                "failed",
                "Direct P2P connection failed (blocked by mobile NAT/firewall). Switch to Cloud Storage for guaranteed delivery."
              );
            }
          }, DISCONNECT_GRACE_MS);
        }
      } else if (state === "failed") {
        this.clearDisconnectTimer();
        this.onStatusChange?.(
          "failed",
          "Direct P2P connection failed (blocked by mobile NAT/firewall). Switch to Cloud Storage for guaranteed delivery."
        );
      }
    };

    controlChannel.onmessage = (e) => {
      if (typeof e.data === "string") {
        try {
          const msg = JSON.parse(e.data) as { type?: string; by?: "sender" | "receiver"; reason?: string };
          if (msg.type === "cancel") {
            this.handlePeerCancelled(msg.by || "receiver", msg.reason);
          }
        } catch {}
      }
    };

    let openCount = 0;
    const totalChannelsToOpen = NUM_CHANNELS + 1;

    const checkAllOpen = () => {
      if (this.pc !== pc || this.isStreaming) return;
      openCount++;
      if (openCount >= totalChannelsToOpen) {
        this.isStreaming = true;
        if (this.pollingInterval) {
          clearInterval(this.pollingInterval);
          this.pollingInterval = null;
        }
        this.onStatusChange?.("streaming", "All channels established! Sending files at maximum speed...");
        this.streamFiles();
      }
    };

    controlChannel.onopen = checkAllOpen;
    for (const dc of this.dataChannels) {
      dc.onopen = checkAllOpen;
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await sendSignal(
      this.transferId,
      "offer",
      { sdp: offer.sdp, type: offer.type },
      "sender"
    );

    if (announceWaiting) {
      this.onStatusChange?.(
        "waiting_for_peer",
        "Waiting for receiver to enter code and connect..."
      );
    }
  }

  public async start() {
    this.onStatusChange?.("initializing", "Creating multi-channel P2P session...");
    await this.setupPeerConnection(true);
    this.startPolling();
  }

  private async flushPendingCandidates() {
    if (!this.pc || !this.pc.remoteDescription) return;
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift()!;
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error("Error adding queued ICE candidate:", e);
      }
    }
  }

  private startPolling() {
    if (this.pollingInterval) clearInterval(this.pollingInterval);

    this.pollingInterval = setInterval(async () => {
      if (this.isDestroyed || this.isCancelled || this.isCompleted) return;

      const signals = await fetchSignals(this.transferId, "sender", this.lastSignalTime);

      for (const sig of signals) {
        this.lastSignalTime = Math.max(this.lastSignalTime, sig.timestamp);
        const statusData = (sig.data ?? {}) as StatusSignalData;

        if ((sig.type === "cancel" || sig.type === "status") && statusData.status === "cancelled") {
          this.handlePeerCancelled(statusData.by || "receiver", statusData.reason);
          return;
        }

        if (sig.type === "status" && statusData.status === "request_offer" && this.answered && !this.isStreaming) {
          this.onStatusChange?.("connecting", "Receiver retrying connection...");
          await this.setupPeerConnection(false);
          continue;
        }

        if (sig.type === "answer" && !this.answered && this.pc) {
          this.answered = true;
          this.onStatusChange?.("connecting", "Receiver joined! Connecting multi-channel...");
          try {
            await this.pc.setRemoteDescription(
              new RTCSessionDescription(sig.data as RTCSessionDescriptionInit)
            );
            await this.flushPendingCandidates();
          } catch (e) {
            console.error("Error setting remote description:", e);
          }
        } else if (sig.type === "candidate" && this.pc && sig.data) {
          const candidateInit = sig.data as RTCIceCandidateInit;
          if (this.pc.remoteDescription) {
            try {
              await this.pc.addIceCandidate(new RTCIceCandidate(candidateInit));
            } catch (e) {
              console.error("Error adding ICE candidate:", e);
            }
          } else {
            this.pendingCandidates.push(candidateInit);
          }
        }
      }
    }, 300);
  }

  private async waitForDrain(dc: RTCDataChannel): Promise<void> {
    if (dc.bufferedAmount <= HIGH_WATERMARK) return;
    return new Promise<void>((resolve) => {
      let resolved = false;
      const onLow = () => {
        if (!resolved) {
          resolved = true;
          dc.removeEventListener("bufferedamountlow", onLow);
          resolve();
        }
      };
      dc.addEventListener("bufferedamountlow", onLow);
      if (dc.bufferedAmount <= LOW_WATERMARK) {
        onLow();
      }
    });
  }

  private selectChannel(): RTCDataChannel {
    let minBuffered = Infinity;
    let bestChannel = this.dataChannels[0];
    for (const dc of this.dataChannels) {
      if (dc.bufferedAmount < minBuffered) {
        minBuffered = dc.bufferedAmount;
        bestChannel = dc;
      }
    }
    return bestChannel;
  }

  private async streamFiles() {
    if (!this.controlChannel || this.dataChannels.length === 0 || this.isDestroyed || this.isCancelled) return;

    const manifest = {
      type: "manifest",
      totalFiles: this.files.length,
      totalBytes: this.totalBytes,
      numChannels: NUM_CHANNELS,
      files: this.files.map((f, i) => ({
        index: i,
        name: f.name,
        size: f.size,
        mimeType: f.type || "video/mp4",
      })),
    };
    this.controlChannel.send(JSON.stringify(manifest));

    const startTime = Date.now();
    let lastProgressTime = startTime;
    let totalBytesSentSoFar = 0;
    let globalSeq = 0;

    for (let fileIndex = 0; fileIndex < this.files.length; fileIndex++) {
      if (this.isDestroyed || this.isCancelled) return;

      const file = this.files[fileIndex];

      this.controlChannel.send(
        JSON.stringify({
          type: "file_start",
          fileIndex,
          name: file.name,
          size: file.size,
          mimeType: file.type || "video/mp4",
          startSeq: globalSeq,
        })
      );

      let fileOffset = 0;
      const fileSize = file.size;

      while (fileOffset < fileSize && !this.isDestroyed && !this.isCancelled) {
        const blockEnd = Math.min(fileOffset + DISK_READ_BLOCK_SIZE, fileSize);
        const blockSlice = file.slice(fileOffset, blockEnd);

        let blockBuffer: ArrayBuffer;
        try {
          blockBuffer = await blockSlice.arrayBuffer();
        } catch (err) {
          console.error("File block read failed:", err);
          this.onStatusChange?.("failed", "Failed to read file from disk.");
          return;
        }

        let blockOffset = 0;
        while (blockOffset < blockBuffer.byteLength && !this.isDestroyed && !this.isCancelled) {
          const dc = this.selectChannel();

          if (dc.bufferedAmount > HIGH_WATERMARK) {
            await this.waitForDrain(dc);
          }

          if (this.isDestroyed || this.isCancelled) return;

          const chunkEnd = Math.min(blockOffset + PACKET_CHUNK_SIZE, blockBuffer.byteLength);
          const rawChunk = blockBuffer.slice(blockOffset, chunkEnd);

          const seqHeader = encodeSeqHeader(globalSeq);
          const framedChunk = new Uint8Array(SEQ_HEADER_SIZE + rawChunk.byteLength);
          framedChunk.set(seqHeader, 0);
          framedChunk.set(new Uint8Array(rawChunk), SEQ_HEADER_SIZE);

          dc.send(framedChunk.buffer);
          globalSeq++;

          blockOffset += rawChunk.byteLength;
          fileOffset += rawChunk.byteLength;

          const now = Date.now();
          if (now - lastProgressTime > 120 || (fileIndex === this.files.length - 1 && fileOffset === fileSize)) {
            let totalBuffered = 0;
            for (const ch of this.dataChannels) {
              totalBuffered += ch.bufferedAmount || 0;
            }
            const currentDispatchedTotal = Math.max(0, totalBytesSentSoFar + fileOffset - totalBuffered);
            const elapsed = (now - startTime) / 1000;
            const speed = elapsed > 0 ? currentDispatchedTotal / elapsed : 0;
            const remaining = Math.max(0, this.totalBytes - currentDispatchedTotal);
            const eta = speed > 0 ? remaining / speed : 0;

            this.onProgress?.({
              bytesTransferred: currentDispatchedTotal,
              totalBytes: this.totalBytes,
              percentage: this.totalBytes > 0 ? Math.min(100, Math.round((currentDispatchedTotal / this.totalBytes) * 100)) : 0,
              speed,
              eta,
              currentFileIndex: fileIndex,
              totalFiles: this.files.length,
              currentFileName: file.name,
              currentFileBytesTransferred: fileOffset,
              currentFileTotalBytes: fileSize,
              currentFilePercentage: fileSize > 0 ? Math.min(100, Math.round((fileOffset / fileSize) * 100)) : 0,
            });

            lastProgressTime = now;
          }
        }
      }

      if (this.isDestroyed || this.isCancelled) return;

      this.controlChannel.send(
        JSON.stringify({
          type: "file_end",
          fileIndex,
          endSeq: globalSeq,
          totalChunks: Math.ceil(file.size / PACKET_CHUNK_SIZE),
        })
      );

      totalBytesSentSoFar += fileSize;
    }

    if (!this.isDestroyed && !this.isCancelled) {
      for (const dc of this.dataChannels) {
        while (dc.bufferedAmount > 0) {
          await new Promise((r) => setTimeout(r, 50));
          if (this.isDestroyed || this.isCancelled) return;
        }
      }

      await new Promise((r) => setTimeout(r, 300));

      this.isCompleted = true;
      this.controlChannel.send(JSON.stringify({ type: "batch_complete", totalSeq: globalSeq }));
      this.onStatusChange?.("completed", "All files transferred successfully!");
    }
  }

  public cancel(by: "sender" | "receiver" = "sender", reason = "Transfer cancelled by sender") {
    if (this.isCancelled || this.isDestroyed) return;
    this.isCancelled = true;

    if (this.controlChannel && this.controlChannel.readyState === "open") {
      try {
        this.controlChannel.send(JSON.stringify({ type: "cancel", by, reason }));
      } catch {}
    }

    sendSignal(this.transferId, "status", { status: "cancelled", by, reason }, "sender");

    const message = by === "sender" ? "Transfer cancelled by you" : "Transfer was cancelled by recipient";
    this.onStatusChange?.("cancelled", message);
    this.destroy();
  }

  private handlePeerCancelled(by: "sender" | "receiver", reason?: string) {
    if (this.isCancelled || this.isDestroyed) return;
    this.isCancelled = true;
    const message =
      reason ||
      (by === "sender" ? "Transfer cancelled by sender" : "Transfer was cancelled by recipient");
    this.onStatusChange?.("cancelled", message);
    this.destroy();
  }

  public destroy() {
    this.isDestroyed = true;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.teardownPeerConnection();
  }
}

// ==============================================
// RECEIVER SESSION (Multi-Channel, Multi-file & Reconnect-Safe)
// ==============================================
export class P2PReceiverSession {
  private pc: RTCPeerConnection | null = null;
  private controlChannel: RTCDataChannel | null = null;
  private dataChannels: RTCDataChannel[] = [];
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private transferId: string;
  private isDestroyed = false;
  private isCancelled = false;
  private isCompleted = false;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSignalTime = 0;

  private fileList: P2PFileMeta[] = [];
  private totalFiles = 1;
  private totalBytes = 0;
  private totalReceivedBytes = 0;

  private currentFileIndex = 0;
  private currentFileMeta: P2PFileMeta | null = null;
  private currentFileReceivedBytes = 0;
  private currentFileEndSeq: number | null = null;

  private chunkMap: Map<number, ArrayBuffer> = new Map();
  private nextExpectedSeq = 0;
  private flushedBlobs: Blob[] = [];
  private pendingFlushSize = 0;

  private startTime = 0;
  private lastProgressTime = 0;

  public onStatusChange?: (status: P2PStatus, message?: string) => void;
  public onProgress?: (progress: P2PProgress) => void;
  public onManifestReceived?: (files: P2PFileMeta[], totalBytes: number) => void;
  public onFileReceived?: (blob: Blob, filename: string, fileIndex: number, totalFiles: number) => void;
  public onBatchComplete?: () => void;

  constructor(transferId: string) {
    this.transferId = transferId;
  }

  private clearDisconnectTimer() {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  public async start(isRetry = false) {
    this.onStatusChange?.("initializing", "Looking up sender session...");

    const pc = new RTCPeerConnection(buildIceServers());
    this.pc = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate && this.pc === pc) {
        sendSignal(this.transferId, "candidate", event.candidate.toJSON(), "receiver");
      }
    };

    const maybeStopPolling = () => {
      const controlReady = this.controlChannel?.readyState === "open";
      const openDataCount = this.dataChannels.filter((dc) => dc.readyState === "open").length;
      if (this.pollingInterval && controlReady && openDataCount >= NUM_CHANNELS) {
        clearInterval(this.pollingInterval);
        this.pollingInterval = null;
      }
    };

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.binaryType = "arraybuffer";

      if (channel.label === "control") {
        this.controlChannel = channel;

        channel.onopen = () => {
          this.clearDisconnectTimer();
          this.onStatusChange?.("streaming", "Control channel established!");
          this.startTime = Date.now();
          this.lastProgressTime = this.startTime;
          maybeStopPolling();
        };

        channel.onmessage = (e) => {
          if (typeof e.data === "string") {
            this.handleControlMessage(e.data);
          }
        };
      } else if (channel.label.startsWith("data-")) {
        this.dataChannels.push(channel);

        channel.onopen = () => {
          this.clearDisconnectTimer();
          maybeStopPolling();
          this.onStatusChange?.("streaming", `${this.dataChannels.length} data channels active! Receiving at maximum speed...`);
        };

        channel.onmessage = (e) => {
          if (e.data instanceof ArrayBuffer) {
            this.handleDataChunk(e.data);
          }
        };
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.pc !== pc || this.isCancelled || this.isDestroyed || this.isCompleted) return;
      const state = pc.connectionState;
      if (state === "connected") {
        this.clearDisconnectTimer();
        this.onStatusChange?.("streaming", "Connected directly to sender! Multi-channel streaming...");
      } else if (state === "disconnected") {
        if (!this.disconnectTimer) {
          this.disconnectTimer = setTimeout(() => {
            this.disconnectTimer = null;
            if (
              this.pc === pc &&
              !this.isCancelled &&
              !this.isDestroyed &&
              !this.isCompleted &&
              (pc.connectionState === "disconnected" || pc.connectionState === "failed")
            ) {
              this.onStatusChange?.(
                "failed",
                "P2P connection lost. Mobile carrier NAT/firewall may be blocking direct transfer — ask the sender to use Cloud Storage mode."
              );
            }
          }, DISCONNECT_GRACE_MS);
        }
      } else if (state === "failed") {
        this.clearDisconnectTimer();
        this.onStatusChange?.(
          "failed",
          "P2P connection lost. Mobile carrier NAT/firewall may be blocking direct transfer — ask the sender to use Cloud Storage mode."
        );
      }
    };

    const retryStartedAt = Date.now();
    if (isRetry) {
      await sendSignal(
        this.transferId,
        "status",
        { status: "request_offer", attemptId: Math.random().toString(36).slice(2, 10) },
        "receiver"
      );
    }

    this.startReceiverPolling(isRetry ? retryStartedAt : 0);
  }

  private handleControlMessage(data: string) {
    try {
      const msg = JSON.parse(data) as {
        type?: string;
        by?: "sender" | "receiver";
        reason?: string;
        totalFiles?: number;
        totalBytes?: number;
        files?: P2PFileMeta[];
        fileIndex?: number;
        name?: string;
        size?: number;
        mimeType?: string;
        startSeq?: number;
        endSeq?: number;
      };
      if (msg.type === "cancel") {
        this.handlePeerCancelled(msg.by || "sender", msg.reason);
        return;
      } else if (msg.type === "manifest") {
        this.totalFiles = msg.totalFiles ?? 1;
        this.totalBytes = msg.totalBytes ?? 0;
        this.fileList = msg.files || [];
        this.onManifestReceived?.(this.fileList, this.totalBytes);
      } else if (msg.type === "file_start") {
        this.currentFileIndex = msg.fileIndex ?? 0;
        this.currentFileMeta = {
          index: msg.fileIndex ?? 0,
          name: msg.name || `video_${(msg.fileIndex ?? 0) + 1}.mp4`,
          size: msg.size ?? 0,
          mimeType: msg.mimeType || "video/mp4",
        };
        this.currentFileReceivedBytes = 0;
        this.currentFileEndSeq = null;
        this.flushedBlobs = [];
        this.pendingFlushSize = 0;
        if (typeof msg.startSeq === "number") {
          this.nextExpectedSeq = msg.startSeq;
        }
      } else if (msg.type === "file_end") {
        const endSeq = typeof msg.endSeq === "number" ? msg.endSeq : undefined;
        this.currentFileEndSeq = endSeq ?? null;
        this.flushSequentialChunks(endSeq);
        this.finalizeCurrentFile(endSeq);
      } else if (msg.type === "batch_complete" || msg.type === "complete") {
        this.isCompleted = true;
        this.clearDisconnectTimer();
        this.flushSequentialChunks();
        if (this.currentFileMeta && (this.flushedBlobs.length > 0 || this.chunkMap.size > 0)) {
          this.finalizeCurrentFile();
        }
        this.onStatusChange?.("completed", "All files received successfully in original quality!");
        this.onBatchComplete?.();
      }
    } catch {}
  }

  private handleDataChunk(data: ArrayBuffer) {
    if (data.byteLength <= SEQ_HEADER_SIZE) return;

    const seq = decodeSeqHeader(data);
    const payload = data.slice(SEQ_HEADER_SIZE);

    this.chunkMap.set(seq, payload);
    this.currentFileReceivedBytes += payload.byteLength;
    this.totalReceivedBytes += payload.byteLength;

    this.flushSequentialChunks(this.currentFileEndSeq ?? undefined);

    const now = Date.now();
    if (now - this.lastProgressTime > 150 || this.totalReceivedBytes === this.totalBytes) {
      const elapsed = (now - this.startTime) / 1000;
      const speed = elapsed > 0 ? this.totalReceivedBytes / elapsed : 0;
      const remaining = Math.max(0, this.totalBytes - this.totalReceivedBytes);
      const eta = speed > 0 ? remaining / speed : 0;

      this.onProgress?.({
        bytesTransferred: this.totalReceivedBytes,
        totalBytes: this.totalBytes || this.totalReceivedBytes,
        percentage: this.totalBytes
          ? Math.min(100, Math.round((this.totalReceivedBytes / this.totalBytes) * 100))
          : 0,
        speed,
        eta,
        currentFileIndex: this.currentFileIndex,
        totalFiles: this.totalFiles,
        currentFileName: this.currentFileMeta?.name,
        currentFileBytesTransferred: this.currentFileReceivedBytes,
        currentFileTotalBytes: this.currentFileMeta?.size,
        currentFilePercentage: this.currentFileMeta?.size
          ? Math.min(100, Math.round((this.currentFileReceivedBytes / this.currentFileMeta.size) * 100))
          : 0,
      });

      this.lastProgressTime = now;
    }
  }

  private flushSequentialChunks(maxSeqExclusive?: number) {
    const BLOB_CONSOLIDATION_SIZE = 8 * 1024 * 1024;
    const batchChunks: ArrayBuffer[] = [];

    while (
      (maxSeqExclusive === undefined || this.nextExpectedSeq < maxSeqExclusive) &&
      this.chunkMap.has(this.nextExpectedSeq)
    ) {
      const chunk = this.chunkMap.get(this.nextExpectedSeq)!;
      this.chunkMap.delete(this.nextExpectedSeq);
      batchChunks.push(chunk);
      this.pendingFlushSize += chunk.byteLength;
      this.nextExpectedSeq++;

      if (this.pendingFlushSize >= BLOB_CONSOLIDATION_SIZE) {
        this.flushedBlobs.push(new Blob(batchChunks));
        batchChunks.length = 0;
        this.pendingFlushSize = 0;
      }
    }

    if (batchChunks.length > 0) {
      this.flushedBlobs.push(new Blob(batchChunks));
    }
  }

  private finalizeCurrentFile(endSeq?: number) {
    if (!this.currentFileMeta) return;

    this.flushSequentialChunks(endSeq);

    if (this.chunkMap.size > 0) {
      const sortedSeqs = Array.from(this.chunkMap.keys())
        .filter((seq) => endSeq === undefined || seq < endSeq)
        .sort((a, b) => a - b);
      if (sortedSeqs.length > 0) {
        const remainingChunks: ArrayBuffer[] = [];
        for (const seq of sortedSeqs) {
          remainingChunks.push(this.chunkMap.get(seq)!);
          this.chunkMap.delete(seq);
        }
        this.flushedBlobs.push(new Blob(remainingChunks));
        this.nextExpectedSeq = Math.max(
          this.nextExpectedSeq,
          (sortedSeqs[sortedSeqs.length - 1] ?? this.nextExpectedSeq) + 1
        );
      }
    }

    const filename = this.currentFileMeta.name || `video_${this.currentFileIndex + 1}.mp4`;
    const mimeType = this.currentFileMeta.mimeType || "video/mp4";
    const blob = new Blob(this.flushedBlobs, { type: mimeType });

    this.flushedBlobs = [];
    this.pendingFlushSize = 0;
    this.currentFileMeta = null;
    this.currentFileEndSeq = null;

    this.onFileReceived?.(blob, filename, this.currentFileIndex, this.totalFiles);

    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      console.warn("Auto-download failed:", e);
    }
  }

  private async flushPendingCandidates() {
    if (!this.pc || !this.pc.remoteDescription) return;
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift()!;
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error("Error adding queued candidate:", e);
      }
    }
  }

  private startReceiverPolling(minOfferTimestamp = 0) {
    let answered = false;
    if (minOfferTimestamp > 0) {
      this.lastSignalTime = minOfferTimestamp - 1000;
    }

    this.pollingInterval = setInterval(async () => {
      if (this.isDestroyed || this.isCancelled || this.isCompleted) return;

      const signals = await fetchSignals(this.transferId, "receiver", this.lastSignalTime);
      const offers = signals.filter(
        (s) => s.type === "offer" && s.timestamp >= minOfferTimestamp
      );
      const latestOffer = offers.length > 0 ? offers[offers.length - 1] : null;

      for (const sig of signals) {
        this.lastSignalTime = Math.max(this.lastSignalTime, sig.timestamp);
        const statusData = (sig.data ?? {}) as StatusSignalData;

        if ((sig.type === "cancel" || sig.type === "status") && statusData.status === "cancelled") {
          this.handlePeerCancelled(statusData.by || "sender", statusData.reason);
          return;
        }
      }

      if (latestOffer && !answered && this.pc) {
        answered = true;
        this.onStatusChange?.("connecting", "Connecting to sender...");

        try {
          await this.pc.setRemoteDescription(
            new RTCSessionDescription(latestOffer.data as RTCSessionDescriptionInit)
          );
          await this.flushPendingCandidates();
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);

          await sendSignal(
            this.transferId,
            "answer",
            { sdp: answer.sdp, type: answer.type },
            "receiver"
          );
        } catch (e) {
          console.error("Error responding to offer:", e);
        }
      }

      for (const sig of signals) {
        if (sig.type === "candidate" && this.pc && sig.data && sig.timestamp >= minOfferTimestamp) {
          const candidateInit = sig.data as RTCIceCandidateInit;
          if (this.pc.remoteDescription) {
            try {
              await this.pc.addIceCandidate(new RTCIceCandidate(candidateInit));
            } catch (e) {
              console.error("Error adding candidate:", e);
            }
          } else {
            this.pendingCandidates.push(candidateInit);
          }
        }
      }
    }, 300);
  }

  public cancel(by: "sender" | "receiver" = "receiver", reason = "Transfer cancelled by recipient") {
    if (this.isCancelled || this.isDestroyed) return;
    this.isCancelled = true;

    if (this.controlChannel && this.controlChannel.readyState === "open") {
      try {
        this.controlChannel.send(JSON.stringify({ type: "cancel", by, reason }));
      } catch {}
    }

    sendSignal(this.transferId, "status", { status: "cancelled", by, reason }, "receiver");

    const message = by === "receiver" ? "Transfer cancelled by you" : "Transfer was cancelled by sender";
    this.onStatusChange?.("cancelled", message);
    this.destroy();
  }

  private handlePeerCancelled(by: "sender" | "receiver", reason?: string) {
    if (this.isCancelled || this.isDestroyed) return;
    this.isCancelled = true;
    const message =
      reason ||
      (by === "sender" ? "Transfer was cancelled by sender" : "Transfer was cancelled by recipient");
    this.onStatusChange?.("cancelled", message);
    this.destroy();
  }

  public destroy() {
    this.isDestroyed = true;
    this.clearDisconnectTimer();
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.controlChannel) {
      try { this.controlChannel.close(); } catch {}
    }
    for (const dc of this.dataChannels) {
      try { dc.close(); } catch {}
    }
    if (this.pc) {
      try { this.pc.close(); } catch {}
    }
  }
}
