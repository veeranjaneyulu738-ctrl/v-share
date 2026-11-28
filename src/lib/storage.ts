import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  del as blobDel,
  getDownloadUrl as blobGetDownloadUrl,
  head as blobHead,
  issueSignedToken as blobIssueSignedToken,
  presignUrl as blobPresignUrl,
} from "@vercel/blob";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export type StorageMode = "blob" | "r2" | "mock";

// ===== Storage Mode Detection =====
export function getStorageMode(): StorageMode {
  if (process.env.STORAGE_MODE === "mock") return "mock";
  if (
    process.env.STORAGE_MODE === "blob" ||
    Boolean(process.env.BLOB_READ_WRITE_TOKEN) ||
    Boolean(process.env.BLOB_STORE_ID)
  ) {
    return "blob";
  }
  const accountId = process.env.R2_ACCOUNT_ID;
  if (
    accountId &&
    !accountId.startsWith("demo-") &&
    accountId !== "your-cloudflare-account-id"
  ) {
    return "r2";
  }
  return "mock";
}

export function isMockMode(): boolean {
  return getStorageMode() === "mock";
}

const DATA_ROOT = process.env.VERCEL
  ? path.join(os.tmpdir(), "v-share-data")
  : path.join(process.cwd(), ".data");

export const STORAGE_ROOT = path.join(DATA_ROOT, "storage");
export const CHUNKS_ROOT = path.join(DATA_ROOT, "chunks");

/** Resolve a user-supplied relative key safely within a root directory. */
export function resolveSafeStoragePath(rootDir: string, unsafeSegment: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, unsafeSegment);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Invalid storage path");
  }
  return resolvedTarget;
}

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getAppUrl(overrideOrigin?: string): string {
  return overrideOrigin || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export function getRequestOrigin(req: {
  headers: { get(name: string): string | null };
  nextUrl: { origin: string; protocol: string };
}): string {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (!host) return req.nextUrl.origin;
  const proto = req.headers.get("x-forwarded-proto") || req.nextUrl.protocol.replace(":", "") || "http";
  return `${proto}://${host}`;
}

// ===== Real S3/R2 Client =====
function getR2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 credentials not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env.local"
    );
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

let r2Client: S3Client | null = null;

export function getClient(): S3Client {
  if (!r2Client) {
    r2Client = getR2Client();
  }
  return r2Client;
}

function getBucket(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME not configured");
  return bucket;
}

// ===== Object Key Generation =====
export function generateObjectKey(transferId: string, filename: string): string {
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const randomSuffix = crypto.randomBytes(8).toString("hex");
  return `uploads/${transferId}/${randomSuffix}_${sanitized}`;
}

// ===== Multipart Upload Operations =====
export async function createMultipartUpload(
  objectKey: string,
  contentType: string
): Promise<string> {
  const mode = getStorageMode();
  if (mode === "blob") {
    return `blob_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
  }
  if (mode === "mock") {
    const uploadId = `mock_up_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
    const uploadDir = resolveSafeStoragePath(CHUNKS_ROOT, uploadId);
    ensureDir(uploadDir);
    fs.writeFileSync(path.join(uploadDir, "meta.json"), JSON.stringify({ objectKey, contentType }), "utf8");
    return uploadId;
  }

  const client = getClient();
  const command = new CreateMultipartUploadCommand({
    Bucket: getBucket(),
    Key: objectKey,
    ContentType: contentType,
  });
  const result = await client.send(command);
  if (!result.UploadId) throw new Error("Failed to create multipart upload");
  return result.UploadId;
}

export async function getPresignedUploadUrl(
  objectKey: string,
  uploadId: string,
  partNumber: number,
  appOrigin?: string
): Promise<string> {
  const mode = getStorageMode();
  if (mode === "blob") {
    return `${getAppUrl(appOrigin)}/api/blob/upload`;
  }
  if (mode === "mock") {
    return `${getAppUrl(appOrigin)}/api/mock-storage/upload?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}&key=${encodeURIComponent(objectKey)}`;
  }

  const client = getClient();
  const command = new UploadPartCommand({
    Bucket: getBucket(),
    Key: objectKey,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(client, command, { expiresIn: 3600 });
}

export async function completeMultipartUpload(
  objectKey: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[]
): Promise<void> {
  const mode = getStorageMode();
  if (mode === "blob") {
    // Client-side @vercel/blob/client upload already finalized the blob object
    return;
  }
  if (mode === "mock") {
    const uploadDir = resolveSafeStoragePath(CHUNKS_ROOT, uploadId);
    const targetFilePath = resolveSafeStoragePath(STORAGE_ROOT, objectKey);
    ensureDir(path.dirname(targetFilePath));

    const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const writeStream = fs.createWriteStream(targetFilePath);

    try {
      for (const part of sortedParts) {
        const partPath = resolveSafeStoragePath(uploadDir, `part_${part.partNumber}`);
        if (!fs.existsSync(partPath)) {
          throw new Error(
            `Uploaded chunk ${part.partNumber} not found on storage instance. Please retry or use Direct P2P Stream.`
          );
        }
        const chunkData = fs.readFileSync(partPath);
        writeStream.write(chunkData);
      }
      writeStream.end();

      // Wait for file write to complete
      await new Promise<void>((resolve, reject) => {
        writeStream.on("finish", () => resolve());
        writeStream.on("error", (err) => reject(err));
      });
    } catch (err) {
      writeStream.destroy();
      try {
        if (fs.existsSync(targetFilePath)) fs.unlinkSync(targetFilePath);
      } catch {}
      throw err;
    }

    // Cleanup chunks directory
    try {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    } catch {}
    return;
  }

  const client = getClient();
  const command = new CompleteMultipartUploadCommand({
    Bucket: getBucket(),
    Key: objectKey,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: parts.map((p) => ({
        PartNumber: p.partNumber,
        ETag: p.etag,
      })),
    },
  });
  await client.send(command);
}

export async function abortMultipartUpload(
  objectKey: string,
  uploadId: string
): Promise<void> {
  const mode = getStorageMode();
  if (mode === "blob") {
    try {
      await blobDel(objectKey);
    } catch {}
    return;
  }
  if (mode === "mock") {
    try {
      const uploadDir = resolveSafeStoragePath(CHUNKS_ROOT, uploadId);
      if (fs.existsSync(uploadDir)) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
      }
    } catch {}
    return;
  }

  try {
    const client = getClient();
    const command = new AbortMultipartUploadCommand({
      Bucket: getBucket(),
      Key: objectKey,
      UploadId: uploadId,
    });
    await client.send(command);
  } catch (error) {
    console.error("Failed to abort multipart upload:", error);
  }
}

async function getBlobPresignedGetUrl(objectKey: string, expiresIn: number): Promise<string> {
  const validUntil = Date.now() + expiresIn * 1000;
  const signedToken = await blobIssueSignedToken({
    pathname: objectKey,
    operations: ["get"],
    validUntil,
  });
  const { presignedUrl } = await blobPresignUrl(signedToken, {
    operation: "get",
    pathname: objectKey,
    access: "private",
    validUntil,
  });
  return presignedUrl;
}

// ===== Presigned Download URL =====
export async function getPresignedDownloadUrl(
  objectKey: string,
  filename: string,
  expiresIn: number = 300,
  appOrigin?: string
): Promise<string> {
  const mode = getStorageMode();
  if (mode === "blob") {
    const presignedUrl = await getBlobPresignedGetUrl(objectKey, expiresIn);
    return blobGetDownloadUrl(presignedUrl);
  }
  if (mode === "mock") {
    return `${getAppUrl(appOrigin)}/api/mock-storage/download?key=${encodeURIComponent(objectKey)}&filename=${encodeURIComponent(filename)}`;
  }

  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
    ResponseContentDisposition: `attachment; filename="${encodeURIComponent(filename)}"`,
  });
  return getSignedUrl(client, command, { expiresIn });
}

// ===== Presigned Preview URL =====
export async function getPresignedPreviewUrl(
  objectKey: string,
  contentType: string,
  expiresIn: number = 300,
  appOrigin?: string
): Promise<string> {
  const mode = getStorageMode();
  if (mode === "blob") {
    return getBlobPresignedGetUrl(objectKey, expiresIn);
  }
  if (mode === "mock") {
    return `${getAppUrl(appOrigin)}/api/mock-storage/preview?key=${encodeURIComponent(objectKey)}`;
  }

  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
    ResponseContentType: contentType,
    ResponseContentDisposition: "inline",
  });
  return getSignedUrl(client, command, { expiresIn });
}

// ===== Head Object =====
export async function headObject(objectKey: string): Promise<{
  contentLength: number;
  contentType: string;
  etag: string;
}> {
  const mode = getStorageMode();
  if (mode === "blob") {
    const meta = await blobHead(objectKey);
    return {
      contentLength: meta.size,
      contentType: meta.contentType || "video/mp4",
      etag: meta.etag || "",
    };
  }
  if (mode === "mock") {
    const filePath = resolveSafeStoragePath(STORAGE_ROOT, objectKey);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Object not found: ${objectKey}`);
    }
    const stat = fs.statSync(filePath);
    return {
      contentLength: stat.size,
      contentType: "video/mp4",
      etag: `"${stat.mtimeMs}"`,
    };
  }

  const client = getClient();
  const command = new HeadObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
  });
  const result = await client.send(command);
  return {
    contentLength: result.ContentLength ?? 0,
    contentType: result.ContentType ?? "application/octet-stream",
    etag: result.ETag ?? "",
  };
}

// ===== Delete Object =====
export async function deleteObject(objectKey: string): Promise<void> {
  const mode = getStorageMode();
  if (mode === "blob") {
    try {
      await blobDel(objectKey);
    } catch (error) {
      console.warn("Blob delete warning:", error);
    }
    return;
  }
  if (mode === "mock") {
    try {
      const filePath = resolveSafeStoragePath(STORAGE_ROOT, objectKey);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}
    return;
  }

  try {
    const client = getClient();
    const command = new DeleteObjectCommand({
      Bucket: getBucket(),
      Key: objectKey,
    });
    await client.send(command);
  } catch (error) {
    console.error("Failed to delete object:", error);
    throw error;
  }
}

// ===== Cleanup Abandoned Uploads =====
export async function cleanupAbandonedUploads(): Promise<number> {
  const mode = getStorageMode();
  if (mode === "blob") {
    return 0;
  }
  if (mode === "mock") {
    let cleaned = 0;
    try {
      if (fs.existsSync(CHUNKS_ROOT)) {
        const dirs = fs.readdirSync(CHUNKS_ROOT);
        const maxAge = 24 * 60 * 60 * 1000;
        const now = Date.now();
        for (const dir of dirs) {
          const dirPath = path.join(CHUNKS_ROOT, dir);
          const stat = fs.statSync(dirPath);
          if (now - stat.mtimeMs > maxAge) {
            fs.rmSync(dirPath, { recursive: true, force: true });
            cleaned++;
          }
        }
      }
    } catch {}
    return cleaned;
  }

  const client = getClient();
  let cleaned = 0;

  try {
    const listCommand = new ListMultipartUploadsCommand({
      Bucket: getBucket(),
    });
    const result = await client.send(listCommand);

    if (!result.Uploads) return 0;

    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;

    for (const upload of result.Uploads) {
      if (upload.Initiated && now - upload.Initiated.getTime() > maxAge) {
        if (upload.Key && upload.UploadId) {
          await abortMultipartUpload(upload.Key, upload.UploadId);
          cleaned++;
        }
      }
    }
  } catch (error) {
    console.error("Failed to cleanup abandoned uploads:", error);
  }

  return cleaned;
}
