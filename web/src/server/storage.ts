import fs from "node:fs/promises";
import path from "node:path";

export function getDataDir() {
  /**
   * Store run artifacts on local disk.
   *
   * IMPORTANT:
   * - In traditional servers, `process.cwd()` is writable.
   * - In serverless (Netlify/Vercel/AWS Lambda), the function bundle filesystem is often read-only.
   *   Use `/tmp` instead (writable but ephemeral).
   *
   * In a real production system, we'd swap this to object storage (S3/GCS/etc).
   */
  if (process.env.DATA_DIR) return process.env.DATA_DIR;

  const isServerless =
    process.env.NETLIFY === "true" ||
    process.env.VERCEL === "1" ||
    typeof process.env.AWS_LAMBDA_FUNCTION_NAME === "string";

  if (isServerless) return path.join("/tmp", "trelent-conventor-data");
  return path.join(process.cwd(), ".data");
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

