import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir, getRunsDir, getUploadsDir } from "@/server/storage";
import { writeRunState } from "@/server/run-store";
import { ensureWorkerStarted, processQueuedRun } from "@/server/worker";
import { createLogger, errorToObject } from "@/server/logger";
import { readRunState } from "@/server/run-store";

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
    // Stream progress updates while we run inline so the UI can show a real progress bar.
    if (isServerlessRuntime()) {
      log.info("serverless: streaming inline run", { runId, uploadId });

      type RunStreamEvent =
        | { type: "runId"; runId: string }
        | {
            type: "status";
            status: "running" | "queued";
            progress: number;
            message?: string;
            current?: { file?: string; index?: number; total?: number };
          }
        | { type: "completed"; runId: string; downloadUrl: string }
        | { type: "failed"; runId: string; error: string };

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (evt: RunStreamEvent) => {
            controller.enqueue(encoder.encode(`${JSON.stringify(evt)}\n`));
          };

          // Kick off async work without blocking `start`.
          void (async () => {
            try {
              send({ type: "runId", runId });
              send({ type: "status", status: "queued", progress: 0, message: "Queued" });

              await processQueuedRun(runId, {
                onProgress: (u) => {
                  send({
                    type: "status",
                    status: "running",
                    progress: Math.max(0, Math.min(100, Math.round(u.progress))),
                    message: u.message,
                    current:
                      u.currentFile || u.currentIndex || u.totalFiles
                        ? { file: u.currentFile, index: u.currentIndex, total: u.totalFiles }
                        : undefined,
                  });
                },
              });

              const finalState = await readRunState(runId);
              if (finalState.status === "completed") {
                send({
                  type: "completed",
                  runId,
                  downloadUrl: `/api/runs/${encodeURIComponent(runId)}/download`,
                });
              } else if (finalState.status === "failed") {
                send({ type: "failed", runId, error: finalState.error || "Failed" });
              } else {
                // Shouldn't happen, but don't leave the client hanging.
                send({ type: "failed", runId, error: "Run did not complete" });
              }
            } catch (e) {
              send({
                type: "failed",
                runId,
                error: e instanceof Error ? e.message : "Failed to process run",
              });
            } finally {
              controller.close();
            }
          })();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-cache, no-transform",
        },
      });
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

