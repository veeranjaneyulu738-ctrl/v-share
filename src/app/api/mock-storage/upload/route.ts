import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import crypto from "crypto";
import { CHUNKS_ROOT, resolveSafeStoragePath } from "@/lib/storage";

export async function PUT(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const uploadId = searchParams.get("uploadId");
    const partNumberRaw = searchParams.get("partNumber");

    if (!uploadId || !partNumberRaw) {
      return NextResponse.json({ error: "Missing uploadId or partNumber" }, { status: 400 });
    }

    const partNumber = Number(partNumberRaw);
    if (!Number.isInteger(partNumber) || partNumber < 1) {
      return NextResponse.json({ error: "Invalid partNumber" }, { status: 400 });
    }

    let uploadDir: string;
    let partFilePath: string;
    try {
      uploadDir = resolveSafeStoragePath(CHUNKS_ROOT, uploadId);
      partFilePath = resolveSafeStoragePath(uploadDir, `part_${partNumber}`);
    } catch {
      return NextResponse.json({ error: "Invalid uploadId" }, { status: 400 });
    }

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Read chunk data
    const arrayBuffer = await req.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Compute etag
    const etag = `"${crypto.createHash("md5").update(buffer).digest("hex")}"`;

    fs.writeFileSync(partFilePath, buffer);

    return new NextResponse(JSON.stringify({ etag, partNumber }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ETag: etag,
      },
    });
  } catch (error) {
    console.error("Mock upload part error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload part failed" },
      { status: 500 }
    );
  }
}
