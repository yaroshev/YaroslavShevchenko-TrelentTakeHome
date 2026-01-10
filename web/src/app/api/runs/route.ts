import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir, getRunsDir, getUploadsDir } from "@/server/storage";
import { writeRunState } from "@/server/run-store";
import { ensureWorkerStarted, processQueuedRun } from "@/server/worker";
import { createLogger, errorToObject } from "@/server/logger";

export const runtime = "nodejs";

function isServerlessRuntime() {
  return (
    process.env.NETLIFY === "true" ||
    process.env.VERCEL === "1" ||
    typeof process.env.AWS_LAMBDA_FUNCTION_NAME === "string"
  );
}

export async function POST(req: Request) {
  const log = createLogger("api.runs.create");
  try {
    const body = (await req.json().catch(() => null)) as { uploadId?: string } | null;
    const uploadId = body?.uploadId;
    if (!uploadId) {
      log.warn("missing uploadId");
      return Response.json({ error: "uploadId is required" }, { status: 400 });
    }

    const uploadDir = path.join(getUploadsDir(), uploadId);
    const inputDir = path.join(uploadDir, "input");
    try {
      const stat = await fs.stat(inputDir);
      if (!stat.isDirectory()) throw new Error();
    } catch {
      log.warn("upload not found", { uploadId, inputDir });
      return Response.json({ error: "Upload not found" }, { status: 404 });
    }

    const runId = crypto.randomUUID();
    await ensureDir(path.join(getRunsDir(), runId));

    const now = new Date().toISOString();
    await writeRunState({
      runId,
      uploadId,
      status: "queued",
      progress: 0,
      message: "Queued",
      createdAt: now,
      updatedAt: now,
    });

    log.info("run queued", { runId, uploadId });
    ensureWorkerStarted();

    // In serverless, background work after returning a response is not reliable.
    // Run the job inline so the user gets a deterministic outcome.
    if (isServerlessRuntime()) {
      log.info("serverless: processing run inline", { runId, uploadId });
      await processQueuedRun(runId);
    }

    return Response.json({ runId });
  } catch (e) {
    log.error("failed to start run", { error: errorToObject(e) });
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to start run" },
      { status: 500 }
    );
  }
}

