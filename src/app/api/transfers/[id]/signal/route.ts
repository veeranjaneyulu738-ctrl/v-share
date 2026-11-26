import { NextRequest, NextResponse } from "next/server";
import { getTransferById, createTransferEvent, getTransferEvents } from "@/lib/dal";

type SignalType = "offer" | "answer" | "candidate" | "status" | "cancel";
type SignalRole = "sender" | "receiver";

interface SignalMetadata {
  from?: SignalRole;
  data?: unknown;
  timestamp?: number;
}

const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  "offer",
  "answer",
  "candidate",
  "status",
  "cancel",
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: transferId } = await params;
    const transfer = await getTransferById(transferId);
    if (!transfer) {
      return NextResponse.json({ error: "Transfer not found" }, { status: 404 });
    }
    if (new Date() > new Date(transfer.expiresAt)) {
      return NextResponse.json({ error: "Transfer has expired" }, { status: 410 });
    }

    const body = await req.json().catch(() => ({}));
    const { type, data, from } = body as {
      type?: SignalType;
      data?: unknown;
      from?: SignalRole;
    };

    if (!type || !ALLOWED_TYPES.has(type) || (from !== "sender" && from !== "receiver")) {
      return NextResponse.json({ error: "Valid type and from role required" }, { status: 400 });
    }

    const event = await createTransferEvent(
      transferId,
      `webrtc_${type}`,
      {
        from,
        data: data ?? null,
        timestamp: Date.now(),
      }
    );

    return NextResponse.json({ success: true, eventId: event.id });
  } catch (error) {
    console.error("WebRTC signal POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to post signal" },
      { status: 500 }
    );
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: transferId } = await params;
    const url = new URL(req.url);
    const forRole = url.searchParams.get("role"); // "sender" wants messages from "receiver", and vice versa
    const rawSince = parseInt(url.searchParams.get("since") || "0", 10);
    const sinceTimestamp = Number.isFinite(rawSince) ? rawSince : 0;

    const allEvents = await getTransferEvents(transferId);

    // Filter WebRTC signals
    const signals = allEvents
      .filter((e) => e.eventType.startsWith("webrtc_"))
      .map((e) => {
        const type = e.eventType.replace("webrtc_", "");
        const meta = (
          typeof e.metadata === "object" && e.metadata !== null ? e.metadata : {}
        ) as SignalMetadata;
        return {
          id: e.id,
          type,
          from: meta.from,
          data: meta.data,
          timestamp: meta.timestamp || new Date(e.createdAt).getTime(),
        };
      })
      .filter((s) => {
        // If since specified, only return newer signals
        if (sinceTimestamp && s.timestamp <= sinceTimestamp) return false;
        // If role specified, return signals FROM the other peer
        if (forRole === "sender" && s.from !== "receiver") return false;
        if (forRole === "receiver" && s.from !== "sender") return false;
        return true;
      });

    return NextResponse.json({ signals });
  } catch (error) {
    console.error("WebRTC signal GET error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get signals" },
      { status: 500 }
    );
  }
}
