import fs from "node:fs/promises";
import path from "node:path";
import { readRunState } from "@/server/run-store";
import { safeJoin } from "@/server/storage";
import { createLogger, errorToObject } from "@/server/logger";

export const runtime = "nodejs";

type ManifestGuide = {
  sourcePath: string;
  outputFile: string;
  title: string;
  status: "ok" | "error";
  error?: string;
};

type Manifest = {
  runId: string;
  uploadId: string;
  guides: ManifestGuide[];
};

function isSafeSingleFileName(name: string) {
  if (!name) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes("\0")) return false;
  return true;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const log = createLogger("api.runs.preview", { runId });

  try {
    const state = await readRunState(runId);
    if (state.status !== "completed") {
      return Response.json({ error: "Run not completed" }, { status: 400 });
    }

    const outDir = path.dirname(state.downloadPath);
    const manifestPath = path.join(outDir, "manifest.json");
    const guidesDir = path.join(outDir, "guides");

    const u = new URL(req.url);
    const file = (u.searchParams.get("file") || "").trim();
    const download = (u.searchParams.get("download") || "").trim() === "1";

    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as Manifest;

    const guides = Array.isArray(manifest.guides)
      ? manifest.guides.filter(
          (g) =>
            g &&
            typeof g === "object" &&
            typeof (g as ManifestGuide).outputFile === "string" &&
            isSafeSingleFileName((g as ManifestGuide).outputFile) &&
            (g as ManifestGuide).outputFile.toLowerCase().endsWith(".html")
        )
      : [];

    if (!file) {
      return Response.json(
        {
          runId,
          uploadId: manifest.uploadId,
          guides,
        },
        { headers: { "cache-control": "no-store" } }
      );
    }

    if (!isSafeSingleFileName(file) || !file.toLowerCase().endsWith(".html")) {
      return Response.json({ error: "Invalid file" }, { status: 400 });
    }

    const allowed = new Set(guides.map((g) => g.outputFile));
    if (!allowed.has(file)) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    const filePath = safeJoin(guidesDir, file);
    const html = await fs.readFile(filePath, "utf8");

    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...(download ? { "content-disposition": `attachment; filename="${file}"` } : null),
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    log.error("preview failed", { error: errorToObject(e) });
    return Response.json(
      { error: e instanceof Error ? e.message : "Preview failed" },
      { status: 500 }
    );
  }
}

