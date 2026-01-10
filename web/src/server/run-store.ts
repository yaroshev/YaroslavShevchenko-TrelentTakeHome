import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, getRunsDir, writeJsonAtomic } from "@/server/storage";

export type RunState =
  | {
      runId: string;
      uploadId: string;
      status: "queued" | "running";
      progress: number;
      message?: string;
      current?: {
        file?: string;
        index?: number;
        total?: number;
        stage?: "reading" | "converting" | "writing" | "zipping";
      };
      createdAt: string;
      updatedAt: string;
    }
  | {
      runId: string;
      uploadId: string;
      status: "completed";
      progress: 100;
      message?: string;
      current?: {
        file?: string;
        index?: number;
        total?: number;
        stage?: "reading" | "converting" | "writing" | "zipping";
      };
      downloadPath: string;
      createdAt: string;
      updatedAt: string;
      completedAt: string;
    }
  | {
      runId: string;
      uploadId: string;
      status: "failed";
      progress: number;
      error: string;
      /**
       * Internal/debug-only error details. Persisted so devtools can inspect the
       * real failure cause while the UI can remain generic.
       *
       * IMPORTANT: Do not expose this to end users in production responses.
       */
      debugError?: unknown;
      current?: {
        file?: string;
        index?: number;
        total?: number;
        stage?: "reading" | "converting" | "writing" | "zipping";
      };
      createdAt: string;
      updatedAt: string;
      failedAt: string;
    };

export function getRunDir(runId: string) {
  return path.join(getRunsDir(), runId);
}

export function getRunStatePath(runId: string) {
  return path.join(getRunDir(runId), "state.json");
}

export function getRunLogPath(runId: string) {
  return path.join(getRunDir(runId), "server.log");
}

export async function readRunState(runId: string): Promise<RunState> {
  const raw = await fs.readFile(getRunStatePath(runId), "utf8");
  return JSON.parse(raw) as RunState;
}

export async function writeRunState(run: RunState) {
  await ensureDir(getRunDir(run.runId));
  await writeJsonAtomic(getRunStatePath(run.runId), run);
}

export async function listRuns(): Promise<string[]> {
  try {
    await ensureDir(getRunsDir());
    const entries = await fs.readdir(getRunsDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

