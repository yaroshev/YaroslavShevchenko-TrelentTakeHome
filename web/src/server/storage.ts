import fs from "node:fs/promises";
import path from "node:path";

export function getDataDir() {
  // Store run artifacts on local disk. In production, mount a volume or swap to object storage.
  return process.env.DATA_DIR || path.join(process.cwd(), ".data");
}

export function getUploadsDir() {
  return path.join(getDataDir(), "uploads");
}

export function getRunsDir() {
  return path.join(getDataDir(), "runs");
}

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export function safeJoin(baseDir: string, unsafeRelativePath: string) {
  const normalized = unsafeRelativePath.replaceAll("\\", "/");
  const rel = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  const finalPath = path.join(baseDir, rel);
  const resolvedBase = path.resolve(baseDir) + path.sep;
  const resolvedFinal = path.resolve(finalPath);
  if (!resolvedFinal.startsWith(resolvedBase)) {
    throw new Error("Invalid path");
  }
  return resolvedFinal;
}

export async function writeJsonAtomic(filePath: string, value: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

