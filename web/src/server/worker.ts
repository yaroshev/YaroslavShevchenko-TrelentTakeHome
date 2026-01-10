import { listRuns, readRunState, writeRunState } from "@/server/run-store";
import { createLogger, errorToObject } from "@/server/logger";

const PUBLIC_RUN_ERROR = "Something went wrong please contact support or retry";

let workerStarted = false;
let workerLoopPromise: Promise<void> | null = null;
const log = createLogger("worker");

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function findNextQueuedRun(): Promise<string | null> {
  const runIds = await listRuns();
  for (const runId of runIds) {
    try {
      const s = await readRunState(runId);
      if (s.status === "queued") return runId;
    } catch {
      // ignore
    }
  }
  return null;
}

async function processRun(runId: string) {
  const state = await readRunState(runId);
  if (state.status !== "queued") return;

  log.info("processRun: starting", { runId, uploadId: state.uploadId });

  const now = new Date().toISOString();
  const runningState = {
    ...state,
    status: "running",
    progress: Math.max(0, state.progress ?? 0),
    updatedAt: now,
    message: "Starting...",
  } as const;
  await writeRunState(runningState);

  try {
    // Dynamic import so dev hot-reloads pick up the latest pipeline logic even if the worker loop
    // stays alive across edits.
    const { runPipeline } = await import("@/server/pipeline");
    const { zipPath } = await runPipeline(runningState, async (u) => {
      const cur = await readRunState(runId);
      if (cur.status !== "running") return;
      await writeRunState({
        ...cur,
        progress: Math.max(0, Math.min(100, u.progress)),
        message: u.message,
        current:
          u.currentFile || u.currentIndex || u.totalFiles || u.stage
            ? {
                file: u.currentFile,
                index: u.currentIndex,
                total: u.totalFiles,
                stage: u.stage,
              }
            : cur.current,
        updatedAt: new Date().toISOString(),
      });
    });

    await writeRunState({
      runId,
      uploadId: state.uploadId,
      status: "completed",
      progress: 100,
      message: "Complete",
      downloadPath: zipPath,
      createdAt: state.createdAt,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    log.info("processRun: completed", { runId, uploadId: state.uploadId, zipPath });
  } catch (e) {
    await writeRunState({
      runId,
      uploadId: state.uploadId,
      status: "failed",
      progress: Math.max(0, state.progress ?? 0),
      // Keep UI copy stable; store real error separately for devtools.
      error: PUBLIC_RUN_ERROR,
      debugError: errorToObject(e),
      createdAt: state.createdAt,
      updatedAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
    });
    log.error("processRun: failed", { runId, uploadId: state.uploadId, error: errorToObject(e) });
  }
}

async function workerLoop() {
  // Single-process, single-worker loop. For scale: move this to a dedicated worker + queue.
  log.info("workerLoop: started");
  while (true) {
    const next = await findNextQueuedRun();
    if (!next) {
      await sleep(800);
      continue;
    }
    log.info("workerLoop: found queued run", { runId: next });
    await processRun(next);
    await sleep(200);
  }
}

export function ensureWorkerStarted() {
  if (workerStarted) return;
  workerStarted = true;
  log.info("ensureWorkerStarted: starting background loop");
  // Fire and forget.
  workerLoopPromise = workerLoop();
  void workerLoopPromise;
}

