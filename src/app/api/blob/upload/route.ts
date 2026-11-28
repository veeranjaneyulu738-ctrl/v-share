import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { getTransferById, getUploadSession } from "@/lib/dal";

interface BlobClientPayload {
  transferId?: string;
  sessionId?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json()) as HandleUploadBody;

    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!clientPayload) {
          throw new Error("Missing upload authorization payload");
        }

        let parsed: BlobClientPayload;
        try {
          parsed = JSON.parse(clientPayload) as BlobClientPayload;
        } catch {
          throw new Error("Invalid upload authorization payload");
        }

        if (!parsed.transferId || !parsed.sessionId) {
          throw new Error("transferId and sessionId are required");
        }

        const transfer = await getTransferById(parsed.transferId);
        if (!transfer) {
          throw new Error("Transfer not found");
        }

        const session = await getUploadSession(parsed.sessionId);
        if (!session || session.transferId !== transfer.id) {
          throw new Error("Upload session not found");
        }

        if (pathname !== session.objectKey) {
          throw new Error("Object path mismatch");
        }

        if (transfer.uploadStatus !== "uploading" && transfer.uploadStatus !== "pending") {
          throw new Error(`Upload cannot accept data in status: ${transfer.uploadStatus}`);
        }

        return {
          maximumSizeInBytes: Math.max(transfer.fileSize + 1024 * 1024, 1024 * 1024),
          addRandomSuffix: false,
          allowOverwrite: true,
          tokenPayload: JSON.stringify({
            transferId: transfer.id,
            sessionId: session.id,
          }),
        };
      },
      onUploadCompleted: async () => {
        // Finalization and SHA-256 verification are triggered explicitly by the client via /api/transfers/[id]/finalize
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    console.error("Blob upload token error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to authorize blob upload" },
      { status: 400 }
    );
  }
}
