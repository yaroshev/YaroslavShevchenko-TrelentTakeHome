import fs from "node:fs/promises";
import { getRunLogPath } from "@/server/run-store";

export type LogLevel = "debug" | "info" | "warn" | "error";

function nowIso() {
  return new Date().toISOString();
}

export function maskSecret(value: string | undefined | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "***";
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-4)}`;
}

function scrubUrlSecrets(s: string) {
  // Best-effort: hide common secret-bearing query params.
  return s.replace(/([?&])(key|token|access_token|api_key)=([^&#]+)/gi, (_m, sep, k) => {
    return `${sep}${k}=***`;
  });
}

function sanitize(value: unknown, keyHint?: string): unknown {
  if (typeof value === "string") {
    if (keyHint && /(key|token|authorization|apiKey)/i.test(keyHint)) return maskSecret(value);
    return scrubUrlSecrets(value);
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitize(v, k);
    }
    return out;
  }
  return value;
}

function extractRunId(payload: Record<string, unknown>): string | null {
  const v = payload.runId;
  return typeof v === "string" && v.trim() ? v : null;
}

async function appendRunLogLine(runId: string, line: string) {
  // Default on. Set RUN_LOGS_TO_FILE=0 to disable.
  if (process.env.RUN_LOGS_TO_FILE === "0") return;
  const filePath = getRunLogPath(runId);
  // Ensure directory exists (avoid importing storage helpers here).
  await fs.mkdir(filePath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  await fs.appendFile(filePath, line + "\n", "utf8");
}

export function errorToObject(e: unknown) {
  if (e instanceof Error) {
    return {
      name: e.name,
      message: e.message,
      stack: e.stack,
      cause: (e as { cause?: unknown }).cause,
    };
  }
  return { value: e };
}

export function createLogger(scope: string, base?: Record<string, unknown>) {
  const emit = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    const payload = sanitize({
      ts: nowIso(),
      scope,
      level,
      msg,
      ...(base || {}),
      ...(meta || {}),
    }) as Record<string, unknown>;

    // Keep logs structured so they can be grepped / parsed.
    if (level === "error") console.error(payload);
    else if (level === "warn") console.warn(payload);
    else if (level === "debug") console.debug(payload);
    else console.log(payload);

    // Also persist run-scoped logs so the UI can show "exact server log" for reviewers.
    // Fire-and-forget to avoid blocking request handlers.
    const runId = extractRunId(payload);
    if (runId) {
      void appendRunLogLine(runId, JSON.stringify(payload));
    }
  };

  return {
    debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
  };
}

export type Logger = ReturnType<typeof createLogger>;

