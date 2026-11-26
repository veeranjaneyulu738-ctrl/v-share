import { NextRequest, NextResponse, connection } from "next/server";
import fs from "fs";
import { STORAGE_ROOT, resolveSafeStoragePath } from "@/lib/storage";

export async function GET(req: NextRequest) {
  await connection();
  try {
    const searchParams = req.nextUrl.searchParams;
    const key = searchParams.get("key");
    const filename = searchParams.get("filename") || "video.mp4";

    if (!key) {
      return NextResponse.json({ error: "Missing key" }, { status: 400 });
    }

    let filePath: string;
    try {
      filePath = resolveSafeStoragePath(STORAGE_ROOT, key);
    } catch {
      return NextResponse.json({ error: "Invalid key" }, { status: 400 });
    }

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const stat = fs.statSync(filePath);
    const fileStream = fs.createReadStream(filePath);

    // Convert node read stream to Web ReadableStream
    const readable = new ReadableStream({
      start(controller) {
        fileStream.on("data", (chunk) => controller.enqueue(chunk));
        fileStream.on("end", () => controller.close());
        fileStream.on("error", (err) => controller.error(err));
      },
      cancel() {
        fileStream.destroy();
      },
    });

    return new NextResponse(readable, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": stat.size.toString(),
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      },
    });
  } catch (error) {
    console.error("Mock download error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Download failed" },
      { status: 500 }
    );
  }
}
