import fs from "node:fs/promises";
import fssync from "node:fs";
import { Readable } from "node:stream";
import { readRunState } from "@/server/run-store";
import { createLogger, errorToObject } from "@/server/logger";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const log = createLogger("api.runs.download", { runId });
  try {
    const state = await readRunState(runId);
    if (state.status !== "completed") {
      log.warn("download requested but run not completed", { status: state.status });
      return Response.json({ error: "Run not completed" }, { status: 400 });
    }

    const zipPath = state.downloadPath;
    const stat = await fs.stat(zipPath);
    if (!stat.isFile()) {
      log.warn("zip not found", { zipPath });
      return Response.json({ error: "Zip not found" }, { status: 404 });
    }

    log.info("streaming zip", { zipPath, sizeBytes: stat.size });
    const nodeStream = fssync.createReadStream(zipPath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    return new Response(webStream, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(stat.size),
        "content-disposition": `attachment; filename="guides-${runId}.zip"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    log.error("download failed", { error: errorToObject(e) });
    return Response.json(
      { error: e instanceof Error ? e.message : "Download failed" },
      { status: 500 }
    );
  }
}

