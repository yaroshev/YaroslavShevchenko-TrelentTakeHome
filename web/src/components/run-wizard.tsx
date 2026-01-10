"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorLightbox } from "./error-lightbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Step = "upload" | "convert" | "done";

type UploadedFile = {
  name: string;
  relativePath: string;
  size: number;
};

type UploadResponse = {
  uploadId: string;
  files: UploadedFile[];
};

type RunStatus =
  | {
      status: "queued" | "running";
      progress: number;
      message?: string;
      current?: { file?: string; index?: number; total?: number };
    }
  | { status: "completed"; progress: 100; downloadUrl: string }
  | { status: "failed"; progress: number; error: string; debugError?: unknown };

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

type WebkitFileWithRelativePath = File & { webkitRelativePath?: string };

type WebkitFsDirectoryReader = {
  readEntries: (
    success: (entries: WebkitFsEntry[]) => void,
    error?: (err: unknown) => void
  ) => void;
};

// The DOM lib types for this API are a bit awkward (and vary across TS/lib versions),
// so we define a narrow helper type that is *assignable to* the built-in FileSystemEntry.
type WebkitFsEntry = FileSystemEntry & {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  // Note: directories do not implement `file()`. Files do.
  file?: (success: (file: File) => void, error?: (err: unknown) => void) => void;
  createReader?: () => WebkitFsDirectoryReader;
};

type DataTransferItemWithWebkit = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntry | null;
};

async function collectFilesFromDrop(
  dataTransfer: DataTransfer
): Promise<Array<{ file: File; relativePath: string }>> {
  const items = Array.from(dataTransfer.items || []);

  // Best effort folder support (Chromium): traverse dropped directories.
  const entries = items
    .map((it) => (it as DataTransferItemWithWebkit).webkitGetAsEntry?.() as WebkitFsEntry | null)
    .filter((e): e is WebkitFsEntry => e != null);

  if (entries.length === 0) {
    // Fallback: plain files.
    return Array.from(dataTransfer.files || []).map((file) => ({
      file,
      relativePath: file.name,
    }));
  }

  const out: Array<{ file: File; relativePath: string }> = [];

  async function walk(entry: WebkitFsEntry, prefix: string) {
    if (entry.isFile) {
      const file: File = await new Promise((resolve, reject) => {
        if (!entry.file) return reject(new Error("Missing file() on file entry"));
        entry.file(resolve, reject);
      });
      out.push({ file, relativePath: `${prefix}${file.name}` });
      return;
    }

    if (entry.isDirectory) {
      const reader = entry.createReader?.();
      if (!reader) return;
      const readAll = async (): Promise<WebkitFsEntry[]> => {
        const batch: WebkitFsEntry[] = await new Promise((resolve, reject) => {
          reader.readEntries(resolve, reject);
        });
        if (batch.length === 0) return [];
        return batch.concat(await readAll());
      };
      const children = await readAll();
      await Promise.all(
        children.map((child) => walk(child, `${prefix}${entry.name}/`))
      );
    }
  }

  await Promise.all(entries.map((e) => walk(e, "")));

  // Deduplicate by relative path.
  const seen = new Set<string>();
  return out.filter(({ relativePath }) => {
    if (seen.has(relativePath)) return false;
    seen.add(relativePath);
    return true;
  });
}

function uploadWithProgress(
  files: Array<{ file: File; relativePath: string }>,
  onProgress: (pct: number) => void
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) {
      // Use the filename field to carry relativePath.
      form.append("files", f.file, f.relativePath || f.file.name);
    }

    console.log(`[API Call] POST /api/upload - Uploading ${files.length} file(s)`);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.responseType = "json";

    xhr.upload.onprogress = (evt) => {
      if (!evt.lengthComputable) return;
      const pct = Math.max(0, Math.min(100, Math.round((evt.loaded / evt.total) * 100)));
      onProgress(pct);
    };

    xhr.onerror = () => {
      console.error(`[API Call] POST /api/upload - FAILED - Network error`);
      reject(new Error("Upload failed"));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        console.log(`[API Call] POST /api/upload - SUCCESS - Status: ${xhr.status}`);
        resolve(xhr.response as UploadResponse);
        return;
      }
      const msg =
        (xhr.response && (xhr.response.error as string)) ||
        `Upload failed (${xhr.status})`;
      console.error(`[API Call] POST /api/upload - FAILED - Status: ${xhr.status} - Error: ${msg}`);
      reject(new Error(msg));
    };

    xhr.send(form);
  });
}

export function RunWizard() {
  const [step, setStep] = useState<Step>("upload");

  const [isDragging, setIsDragging] = useState(false);
  const [picked, setPicked] = useState<Array<{ file: File; relativePath: string }>>([]);

  const [uploadPct, setUploadPct] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadedSignatureRef = useRef<string | null>(null);
  const lastUploadAttemptSignatureRef = useRef<string | null>(null);
  const autoUploadTimerRef = useRef<number | null>(null);

  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const lastPollSigRef = useRef<string | null>(null);
  const [showErrorLightbox, setShowErrorLightbox] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [reviewerLog, setReviewerLog] = useState<string>("");
  const [reviewerLogStatus, setReviewerLogStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [reviewerLogError, setReviewerLogError] = useState<string | null>(null);
  const [didCopyReviewerLog, setDidCopyReviewerLog] = useState(false);

  const copyReviewerLog = useCallback(async () => {
    const text =
      reviewerLog ||
      "(No run-scoped log captured yet. Trigger another run to populate it.)";

    try {
      await navigator.clipboard.writeText(text);
      setDidCopyReviewerLog(true);
      window.setTimeout(() => setDidCopyReviewerLog(false), 1200);
    } catch {
      // Clipboard can fail in some contexts; fall back to a temporary textarea.
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "true");
      el.style.position = "fixed";
      el.style.left = "-9999px";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setDidCopyReviewerLog(true);
      window.setTimeout(() => setDidCopyReviewerLog(false), 1200);
    }
  }, [reviewerLog]);

  const totalBytes = useMemo(
    () => picked.reduce((sum, f) => sum + f.file.size, 0),
    [picked]
  );

  const pickedSignature = useMemo(
    () =>
      picked
        .map((f) => `${f.relativePath}:${f.file.size}:${f.file.lastModified}`)
        .sort()
        .join("|"),
    [picked]
  );

  const canConvert = !!uploadId && !isUploading;

  const resetWizard = useCallback(() => {
    setStep("upload");
    setIsDragging(false);
    setPicked([]);

    setUploadPct(0);
    setIsUploading(false);
    setUploadId(null);
    setUploadError(null);
    uploadedSignatureRef.current = null;
    lastUploadAttemptSignatureRef.current = null;
    lastPollSigRef.current = null;

    setRunId(null);
    setRunStatus(null);

    setShowErrorLightbox(false);
    setErrorMessage(null);

    if (autoUploadTimerRef.current) {
      window.clearTimeout(autoUploadTimerRef.current);
      autoUploadTimerRef.current = null;
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const invalidateUpload = useCallback(() => {
    setUploadId(null);
    setUploadPct(0);
    setIsUploading(false);
    uploadedSignatureRef.current = null;
    lastUploadAttemptSignatureRef.current = null;
  }, []);

  const mergePicked = useCallback(
    (next: Array<{ file: File; relativePath: string }>) => {
      setPicked((cur) => {
        const byPath = new Map<string, { file: File; relativePath: string }>();
        for (const f of cur) byPath.set(f.relativePath, f);
        for (const f of next) byPath.set(f.relativePath, f);
        return Array.from(byPath.values());
      });
    },
    []
  );

  const removePickedFile = useCallback(
    (relativePath: string) => {
      setPicked((cur) => cur.filter((f) => f.relativePath !== relativePath));
      if (uploadId) invalidateUpload();
    },
    [uploadId, invalidateUpload]
  );

  const onPickFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploadError(null);
      const next = Array.from(files).map((file) => ({
        file,
        relativePath: (file as WebkitFileWithRelativePath).webkitRelativePath || file.name,
      }));
      mergePicked(next);
    },
    [mergePicked]
  );

  const startUpload = useCallback(async () => {
    if (picked.length === 0) return;
    setIsUploading(true);
    setUploadPct(0);
    setUploadError(null);
    lastUploadAttemptSignatureRef.current = pickedSignature;
    try {
      console.info("[RunWizard] upload: start", {
        count: picked.length,
        files: picked.map((f) => ({ relativePath: f.relativePath, size: f.file.size })),
      });
      const res = await uploadWithProgress(picked, setUploadPct);
      setUploadId(res.uploadId);
      setUploadPct(100);
      console.info("[RunWizard] upload: complete", { uploadId: res.uploadId, files: res.files });
      uploadedSignatureRef.current = pickedSignature;
    } catch (e) {
      console.error("[RunWizard] upload: failed", e);
      setUploadError(e instanceof Error ? e.message : "Upload failed");
      setUploadId(null);
    } finally {
      setIsUploading(false);
    }
  }, [picked, pickedSignature]);

  const startConvert = useCallback(async () => {
    if (!uploadId) return;
    setRunId(null);
    setRunStatus({ status: "queued", progress: 0, message: "Starting..." });
    lastPollSigRef.current = null;
    console.info("[RunWizard] convert: start", { uploadId });

    let newRunId: string | null = null;
    console.log(`[API Call] POST /api/runs - Starting conversion for uploadId: ${uploadId}`);
    try {
      const resp = await fetch("/api/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson, application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ uploadId }),
      });
      const contentType = resp.headers.get("content-type") || "";

      // Server can stream NDJSON progress (used in serverless environments like Netlify).
      if (resp.ok && contentType.includes("application/x-ndjson")) {
        if (!resp.body) throw new Error("Missing response body");

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const handleEvent = (evt: unknown) => {
          const t = (evt as { type?: unknown } | null)?.type;
          if (t === "runId") {
            const id = (evt as { runId?: unknown }).runId;
            if (typeof id === "string") {
              newRunId = id;
              setRunId(id);
            }
            return;
          }
          if (t === "status") {
            const e = evt as {
              status?: "queued" | "running";
              progress?: number;
              message?: string;
              current?: { file?: string; index?: number; total?: number };
            };
            if (e.status && typeof e.progress === "number") {
              setRunStatus({
                status: e.status,
                progress: e.progress,
                message: e.message,
                current: e.current,
              });
            }
            return;
          }
          if (t === "completed") {
            const id = (evt as { runId?: unknown }).runId;
            if (typeof id === "string") {
              newRunId = id;
              setRunId(id);
              setRunStatus({
                status: "completed",
                progress: 100,
                downloadUrl: `/api/runs/${encodeURIComponent(id)}/download`,
              });
              setStep("done");
            } else {
              setRunStatus({
                status: "completed",
                progress: 100,
                downloadUrl: `/api/runs/${encodeURIComponent(newRunId || "")}/download`,
              });
              setStep("done");
            }
            return;
          }
          if (t === "failed") {
            const errorMsg =
              typeof (evt as { error?: unknown } | null)?.error === "string"
                ? (evt as { error: string }).error
                : "Failed to start conversion";
            setRunStatus({ status: "failed", progress: 0, error: errorMsg });
            setErrorMessage(errorMsg);
            setShowErrorLightbox(true);
            return;
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              handleEvent(JSON.parse(trimmed) as unknown);
            } catch (e) {
              console.warn("[RunWizard] convert: failed to parse NDJSON line", { line, e });
            }
          }
        }

        // If the stream ends without an explicit completion/failure, fall back to polling once.
        if (!newRunId) {
          const errorMsg = "Invalid response from server";
          setRunStatus({ status: "failed", progress: 0, error: errorMsg });
          setErrorMessage(errorMsg);
          setShowErrorLightbox(true);
        }
        return;
      }

      const body: unknown = await resp.json().catch(() => null);
      if (!resp.ok) {
        const errorMsg =
          typeof (body as { error?: unknown } | null)?.error === "string"
            ? (body as { error: string }).error
            : "Failed to start conversion";
        console.error(`[API Call] POST /api/runs - FAILED - Status: ${resp.status} - Error: ${errorMsg}`);
        setRunStatus({
          status: "failed",
          progress: 0,
          error: errorMsg,
        });
        setErrorMessage(errorMsg);
        setShowErrorLightbox(true);
        return;
      }

      newRunId =
        typeof (body as { runId?: unknown } | null)?.runId === "string"
          ? (body as { runId: string }).runId
          : null;
      if (!newRunId) {
        const errorMsg = "Invalid response from server";
        console.error(`[API Call] POST /api/runs - FAILED - Invalid response: missing runId`);
        setRunStatus({
          status: "failed",
          progress: 0,
          error: errorMsg,
        });
        setErrorMessage(errorMsg);
        setShowErrorLightbox(true);
        return;
      }
      setRunId(newRunId);
      console.log(`[API Call] POST /api/runs - SUCCESS - RunId: ${newRunId}`);
      console.info("[RunWizard] convert: run created", { runId: newRunId, uploadId });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Failed to start conversion";
      console.error(`[API Call] POST /api/runs - FAILED - Exception: ${errorMsg}`, e);
      setRunStatus({
        status: "failed",
        progress: 0,
        error: errorMsg,
      });
      setErrorMessage(errorMsg);
      setShowErrorLightbox(true);
      return;
    }

    if (!newRunId) {
      // This shouldn't happen, but TypeScript needs this check
      return;
    }

    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        console.log(`[API Call] GET /api/runs/${newRunId} - Polling status`);
        const r = await fetch(`/api/runs/${encodeURIComponent(newRunId)}`, {
          cache: "no-store",
        });
        if (!r.ok) {
          console.error(`[API Call] GET /api/runs/${newRunId} - FAILED - Status: ${r.status}`);
          setRunStatus({
            status: "failed",
            progress: 0,
            error: "Something went wrong please contact support or retry",
          });
          return;
        }
        const s = (await r.json()) as RunStatus;
        setRunStatus(s);

        const sig =
          s.status === "failed"
            ? `failed:${s.progress}:${s.error}`
            : s.status === "completed"
              ? `completed:100`
              : `working:${Math.round(s.progress)}:${("current" in s && s.current?.file) || ""}:${(
                  "current" in s && s.current?.index
                ) || ""}:${("current" in s && s.current?.total) || ""}`;
        if (sig !== lastPollSigRef.current) {
          lastPollSigRef.current = sig;
          console.info("[RunWizard] convert: status", { runId: newRunId, status: s });
        }

        if (s.status === "completed") {
          console.log(`[API Call] GET /api/runs/${newRunId} - Status: completed`);
          setStep("done");
          return;
        }
        if (s.status === "failed") {
          const errorMsg = ("error" in s && s.error) || "Unknown error";
          console.error(`[API Call] GET /api/runs/${newRunId} - Status: failed - Error: ${errorMsg}`);
          if ("debugError" in s && s.debugError) {
            console.error(`[API Call] GET /api/runs/${newRunId} - DebugError:`, s.debugError);
          }
          setErrorMessage(errorMsg);
          setShowErrorLightbox(true);
          return;
        }
      } catch (e) {
        const errorMsg = "Something went wrong please contact support or retry";
        console.error(`[API Call] GET /api/runs/${newRunId} - FAILED - Exception: ${e instanceof Error ? e.message : String(e)}`, e);
        setRunStatus({
          status: "failed",
          progress: 0,
          error: errorMsg,
        });
        setErrorMessage(errorMsg);
        setShowErrorLightbox(true);
        return;
      }

      setTimeout(poll, 1200);
    };
    poll();

    return () => {
      cancelled = true;
    };
  }, [uploadId]);

  const fetchReviewerLog = useCallback(async () => {
    if (!runId) return;
    setReviewerLogStatus("loading");
    setReviewerLogError(null);
    try {
      const resp = await fetch(`/api/runs/${encodeURIComponent(runId)}/log?tail=400`, {
        cache: "no-store",
      });
      const body: unknown = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg =
          typeof (body as { error?: unknown } | null)?.error === "string"
            ? (body as { error: string }).error
            : `Failed to fetch log (${resp.status})`;
        throw new Error(msg);
      }
      const logText =
        typeof (body as { log?: unknown } | null)?.log === "string"
          ? (body as { log: string }).log
          : "";
      setReviewerLog(logText);
      setReviewerLogStatus("ready");
    } catch (e) {
      setReviewerLogStatus("error");
      setReviewerLogError(e instanceof Error ? e.message : "Failed to fetch log");
    }
  }, [runId]);

  const goToConvertAndStart = useCallback(() => {
    setStep("convert");
    void startConvert();
  }, [startConvert]);

  const onDrop = useCallback(async (evt: React.DragEvent<HTMLDivElement>) => {
    evt.preventDefault();
    evt.stopPropagation();
    setIsDragging(false);
    setUploadError(null);

    const files = await collectFilesFromDrop(evt.dataTransfer);
    if (files.length === 0) return;
    mergePicked(files);
  }, [mergePicked]);

  // Auto-upload immediately after files are selected/dropped.
  useEffect(() => {
    if (picked.length === 0) {
      invalidateUpload();
      return;
    }

    if (uploadedSignatureRef.current === pickedSignature && uploadId) return;
    if (isUploading) return;

    // If an upload already failed for this exact selection, don't auto-retry forever.
    // Let the user explicitly click Retry (or change the selection).
    if (
      uploadError &&
      lastUploadAttemptSignatureRef.current === pickedSignature &&
      !uploadId
    ) {
      return;
    }

    // Selection changed; force a new upload.
    if (uploadId) setUploadId(null);
    setUploadError(null);
    setUploadPct(0);

    if (autoUploadTimerRef.current) {
      window.clearTimeout(autoUploadTimerRef.current);
    }
    autoUploadTimerRef.current = window.setTimeout(() => {
      void startUpload();
    }, 350);

    return () => {
      if (autoUploadTimerRef.current) {
        window.clearTimeout(autoUploadTimerRef.current);
        autoUploadTimerRef.current = null;
      }
    };
  }, [picked, pickedSignature, uploadId, isUploading, uploadError, invalidateUpload, startUpload]);

  // On the final step, load the server log for reviewer debugging.
  useEffect(() => {
    if (step !== "done" || !runId) return;
    void fetchReviewerLog();
  }, [step, runId, fetchReviewerLog]);

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      {step === "upload" && (
        <div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">Step 1: Upload</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Upload your documentation by dragging a folder or selecting files.
              </p>
            </div>
          </div>

          <div
            onDragEnter={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            className={[
              "mt-5 rounded-xl border border-dashed p-8 transition",
              isDragging ? "border-primary bg-muted/40" : "border-border bg-muted/20",
            ].join(" ")}
          >
            <div className="flex flex-col items-center text-center">
              <div className="text-sm font-medium">Drag &amp; drop your files (or a folder) here</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Or click “Add files” to browse from your computer
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  className={[
                    "rounded-md px-3 py-2 text-sm font-medium",
                    uploadId
                      ? "border border-blue-600 bg-transparent text-blue-600 hover:bg-blue-50"
                      : "bg-blue-600 text-white hover:bg-blue-700",
                  ].join(" ")}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploadId ? "Add more" : "Add files"}
                </button>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => onPickFiles(e.target.files)}
            />
          </div>

          {picked.length > 0 && (
            <div className="mt-5">
              <div className="flex items-center justify-between gap-4">
                <div className="text-sm">
                  <span className="font-medium">{picked.length}</span>{" "}
                  <span className="text-muted-foreground">
                    item{picked.length === 1 ? "" : "s"} selected
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatBytes(totalBytes)}
                </div>
              </div>

              <div className="mt-3 max-h-40 overflow-auto rounded-md border bg-background">
                <ul className="divide-y">
                  {picked.slice(0, 50).map((f) => (
                    <li
                      key={f.relativePath}
                      className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="truncate">{f.relativePath}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-xs text-muted-foreground">
                          {formatBytes(f.file.size)}
                        </span>
                        <button
                          type="button"
                          onClick={() => removePickedFile(f.relativePath)}
                          className="rounded-md border border-red-500/60 bg-background px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                  {picked.length > 50 && (
                    <li className="px-3 py-2 text-xs text-muted-foreground">
                      Showing first 50 items
                    </li>
                  )}
                </ul>
              </div>

              <div className="mt-5 flex flex-col gap-3">
                {isUploading && (
                  <div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Uploading</span>
                      <span>{uploadPct}%</span>
                    </div>
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${uploadPct}%` }}
                      />
                    </div>
                  </div>
                )}

                {uploadError && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    <div className="min-w-0">{uploadError}</div>
                    <button
                      type="button"
                      onClick={() => void startUpload()}
                      className="shrink-0 rounded-md border border-destructive/40 bg-background px-2 py-1 text-xs text-destructive hover:bg-destructive/5"
                    >
                      Retry upload
                    </button>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-end gap-3">
                  {uploadId && (
                    <button
                      type="button"
                      onClick={goToConvertAndStart}
                      className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Convert
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {step === "convert" && (
        <div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">Step 2: Convert</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                This may take a moment.
              </p>
            </div>
          </div>

          <div className="mt-6">
            {!runStatus && (
              <div className="flex flex-wrap items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={startConvert}
                  disabled={!canConvert}
                  className={[
                    "rounded-md px-4 py-2 text-sm font-medium",
                    !canConvert
                      ? "cursor-not-allowed bg-muted text-muted-foreground"
                      : "bg-blue-600 text-white hover:bg-blue-700",
                  ].join(" ")}
                >
                  Convert
                </button>
              </div>
            )}

            {runStatus && (
              <>
                {runStatus.status !== "failed" &&
                  "current" in runStatus &&
                  runStatus.current?.file &&
                  runStatus.current.index &&
                  runStatus.current.total && (
                    <div className="mb-3 text-sm text-muted-foreground">
                      Processing:{" "}
                      <span className="font-medium text-foreground">
                        {runStatus.current.file}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        ({runStatus.current.index}/{runStatus.current.total})
                      </span>
                    </div>
                  )}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {runStatus?.status === "failed"
                      ? "Failed"
                      : runStatus?.status === "completed"
                        ? "Done"
                        : "Working"}
                  </span>
                  <span>{Math.round(runStatus?.progress ?? 0)}%</span>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={[
                      "h-full transition-all",
                      runStatus?.status === "failed" ? "bg-destructive" : "bg-primary",
                    ].join(" ")}
                    style={{ width: `${Math.round(runStatus?.progress ?? 0)}%` }}
                  />
                </div>
                {"message" in runStatus && runStatus.message && (
                  <div className="mt-4 text-sm text-muted-foreground">
                    {runStatus.message}
                  </div>
                )}
                {runId && (
                  <div className="mt-3 text-xs text-muted-foreground">
                    Run ID: <span className="font-mono">{runId}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {step === "done" && runStatus?.status === "completed" && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Step 3: Download</CardTitle>
              <CardDescription>Your zip file is ready.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-3">
                <a
                  href={runStatus.downloadUrl}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-95"
                >
                  Download zip
                </a>
                <button
                  type="button"
                  onClick={resetWizard}
                  className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
                >
                  Convert more
                </button>
              </div>
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>For reviewers</CardTitle>
              <CardDescription>
                Run-scoped server log + what the end-user sees if a run fails.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={`/api/runs/${encodeURIComponent(runId || "")}/log?format=pretty&tail=400`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
                  >
                    Open raw log
                  </a>
                  <button
                    type="button"
                    onClick={fetchReviewerLog}
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
                  >
                    Refresh log
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setErrorMessage("Something went wrong please contact support or retry");
                      setShowErrorLightbox(true);
                    }}
                    className="rounded-md border border-blue-600 bg-transparent px-3 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50"
                  >
                    Show failure UI
                  </button>
                </div>

                <button
                  type="button"
                  onClick={copyReviewerLog}
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
                >
                  {didCopyReviewerLog ? "Copied" : "Copy log"}
                </button>
              </div>

              {reviewerLogStatus === "loading" && (
                <div className="mt-3 text-sm text-muted-foreground">Loading log…</div>
              )}
              {reviewerLogStatus === "error" && reviewerLogError && (
                <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {reviewerLogError}
                </div>
              )}

              <pre className="mt-4 max-h-64 overflow-auto rounded-md border bg-muted/20 p-3 text-xs leading-relaxed">
                {reviewerLog ||
                  "(No run-scoped log captured yet. Trigger another run to populate it.)"}
              </pre>
            </CardContent>
          </Card>
        </>
      )}

      {showErrorLightbox && errorMessage && (
        <ErrorLightbox
          error={errorMessage}
          onRetry={() => {
            if (uploadId) {
              setStep("convert");
              startConvert();
            }
          }}
          onClose={() => {
            resetWizard();
            setShowErrorLightbox(false);
            setErrorMessage(null);
          }}
        />
      )}
    </div>
  );
}

