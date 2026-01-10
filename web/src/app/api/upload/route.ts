import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, getUploadsDir, safeJoin } from "@/server/storage";
import { createLogger, errorToObject } from "@/server/logger";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const log = createLogger("api.upload");
  try {
    const form = await req.formData();
    const files = form.getAll("files");
    if (!files || files.length === 0) {
      log.warn("no files received");
      return Response.json({ error: "No files received" }, { status: 400 });
    }

    const uploadId = crypto.randomUUID();
    log.info("upload start", { uploadId, receivedItems: files.length });
    const uploadDir = path.join(getUploadsDir(), uploadId);
    const inputDir = path.join(uploadDir, "input");
    await ensureDir(inputDir);

    const saved: Array<{ name: string; relativePath: string; size: number }> = [];

    for (const item of files) {
      if (!(item instanceof File)) continue;
      const relativePath = item.name || "file";
      const targetPath = safeJoin(inputDir, relativePath);
      await ensureDir(path.dirname(targetPath));
      const buf = Buffer.from(await item.arrayBuffer());
      await fs.writeFile(targetPath, buf);
      saved.push({
        name: path.basename(relativePath),
        relativePath,
        size: item.size,
      });
    }

    if (saved.length === 0) {
      log.warn("no valid File items received", { uploadId });
      return Response.json({ error: "No valid files received" }, { status: 400 });
    }

    log.info("upload complete", {
      uploadId,
      savedCount: saved.length,
      files: saved.map((f) => ({ relativePath: f.relativePath, size: f.size })),
    });
    return Response.json({ uploadId, files: saved });
  } catch (e) {
    log.error("upload failed", { error: errorToObject(e) });
    return Response.json(
      { error: e instanceof Error ? e.message : "Upload failed" },
      { status: 500 }
    );
  }
}

