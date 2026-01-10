import fs from "node:fs/promises";
import { getRunLogPath } from "@/server/run-store";
import { createLogger, errorToObject } from "@/server/logger";

export const runtime = "nodejs";

function tailLines(text: string, n: number) {
  if (n <= 0) return "";
  const lines = text.split(/\r?\n/);
  // Drop trailing empty line from file ending with newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

function prettyJsonLines(text: string) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out: string[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      out.push(JSON.stringify(obj, null, 2));
    } catch {
      out.push(line);
    }
  }
  return out.join("\n\n");
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const log = createLogger("api.runs.log", { runId });
  try {
    const u = new URL(req.url);
    const tail = Math.max(0, Math.min(2000, Number(u.searchParams.get("tail") || 300)));
    const format = u.searchParams.get("format") || "json";

    const filePath = getRunLogPath(runId);
    let raw = "";
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      raw = "";
    }

    const sliced = tail ? tailLines(raw, tail) : raw;
    const out = format === "pretty" ? prettyJsonLines(sliced) : sliced;

    if (format === "text" || format === "pretty") {
      return new Response(out, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    return Response.json(
      {
        runId,
        tail,
        log: out,
        note:
          "This is a best-effort run-scoped server log intended for reviewer debugging. Secrets are scrubbed, but avoid using this in production as-is.",
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    log.error("failed to read run log", { error: errorToObject(e) });
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to read log" },
      { status: 500 }
    );
  }
}

