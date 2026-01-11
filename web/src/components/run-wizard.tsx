"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorLightbox } from "./error-lightbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Download, Maximize, Minimize, X } from "lucide-react";

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

type PreviewGuide = {
  sourcePath: string;
  outputFile: string;
  title: string;
  status: "ok" | "error";
  error?: string;
};

type PreviewIndexResponse = {
  runId: string;
  uploadId: string;
  guides: PreviewGuide[];
};

type HtmlEditMessage = {
  role: "user" | "assistant";
  content: string;
};

type HtmlVersion = {
  id: string;
  createdAt: number;
  label: string;
  instruction?: string;
  html: string;
  source: "original" | "llm";
};

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function wrapPreviewDoc(title: string, fragment: string) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        padding: 24px;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji",
          "Segoe UI Emoji";
        line-height: 1.55;
        color: #0f172a;
        background: #ffffff;
      }
      a { color: #2563eb; text-decoration: none; }
      a:hover { text-decoration: underline; }
      pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
      pre { padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; overflow: auto; }
      hr { border: 0; border-top: 1px solid #e2e8f0; margin: 16px 0; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #e2e8f0; padding: 8px; vertical-align: top; }
      blockquote { margin: 0; padding-left: 12px; border-left: 3px solid #e2e8f0; color: #475569; }
      img { max-width: 100%; height: auto; }
      .container { max-width: 960px; margin: 0 auto; }
    </style>
  </head>
  <body>
    <div class="container">
      ${fragment || ""}
    </div>
  </body>
</html>`;
}

function downloadTextFile(opts: { filename: string; text: string; mime: string }) {
  const blob = new Blob([opts.text], { type: opts.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = opts.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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

  const [previewGuides, setPreviewGuides] = useState<PreviewGuide[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number>(0);
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [previewStatus, setPreviewStatus] = useState<
    "idle" | "loading-index" | "loading-html" | "ready" | "error"
  >("idle");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
  const previewFullscreenElRef = useRef<HTMLDivElement | null>(null);

  const [isAiEditOpen, setIsAiEditOpen] = useState(false);
  const [aiInput, setAiInput] = useState("");
  const [aiMessages, setAiMessages] = useState<HtmlEditMessage[]>([]);
  const [isAiApplying, setIsAiApplying] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiProviderPref, setAiProviderPref] = useState<"auto" | "openai" | "gemini">("auto");

  const [htmlVersionsByFile, setHtmlVersionsByFile] = useState<Record<string, HtmlVersion[]>>(
    {}
  );
  const [selectedVersionByFile, setSelectedVersionByFile] = useState<Record<string, string>>(
    {}
  );
  const lastRunIdRef = useRef<string | null>(null);

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
  const isProcessing =
    step === "convert" &&
    !!runStatus &&
    (runStatus.status === "queued" || runStatus.status === "running");

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

    setIsAiEditOpen(false);
    setAiInput("");
    setAiMessages([]);
    setAiError(null);
    setIsAiApplying(false);
    setAiProviderPref("auto");
    setHtmlVersionsByFile({});
    setSelectedVersionByFile({});
    lastRunIdRef.current = null;
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

    const runIdForPoll = newRunId;

    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        console.log(`[API Call] GET /api/runs/${runIdForPoll} - Polling status`);
        const r = await fetch(`/api/runs/${encodeURIComponent(runIdForPoll)}`, {
          cache: "no-store",
        });
        if (!r.ok) {
          console.error(`[API Call] GET /api/runs/${runIdForPoll} - FAILED - Status: ${r.status}`);
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
          console.info("[RunWizard] convert: status", { runId: runIdForPoll, status: s });
        }

        if (s.status === "completed") {
          console.log(`[API Call] GET /api/runs/${runIdForPoll} - Status: completed`);
          setStep("done");
          return;
        }
        if (s.status === "failed") {
          const errorMsg = ("error" in s && s.error) || "Unknown error";
          console.error(
            `[API Call] GET /api/runs/${runIdForPoll} - Status: failed - Error: ${errorMsg}`
          );
          if ("debugError" in s && s.debugError) {
            console.error(`[API Call] GET /api/runs/${runIdForPoll} - DebugError:`, s.debugError);
          }
          setErrorMessage(errorMsg);
          setShowErrorLightbox(true);
          return;
        }
      } catch (e) {
        const errorMsg = "Something went wrong please contact support or retry";
        console.error(
          `[API Call] GET /api/runs/${runIdForPoll} - FAILED - Exception: ${e instanceof Error ? e.message : String(e)}`,
          e
        );
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

  // On the final step, load preview index (manifest) so we can show an HTML carousel.
  useEffect(() => {
    if (step !== "done" || !runId) return;
    if (runStatus?.status !== "completed") return;

    const controller = new AbortController();
    setPreviewStatus("loading-index");
    setPreviewError(null);

    void (async () => {
      try {
        const resp = await fetch(`/api/runs/${encodeURIComponent(runId)}/preview`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body: unknown = await resp.json().catch(() => null);
        if (!resp.ok) {
          const msg =
            typeof (body as { error?: unknown } | null)?.error === "string"
              ? (body as { error: string }).error
              : `Failed to load preview (${resp.status})`;
          throw new Error(msg);
        }
        const guides =
          Array.isArray((body as PreviewIndexResponse | null)?.guides) &&
          (body as PreviewIndexResponse).guides.length > 0
            ? (body as PreviewIndexResponse).guides
            : [];
        setPreviewGuides(guides);
        setPreviewIndex((cur) => {
          if (guides.length === 0) return 0;
          return Math.max(0, Math.min(cur, guides.length - 1));
        });
        setPreviewStatus(guides.length ? "loading-html" : "ready");
      } catch (e) {
        if ((e as { name?: unknown } | null)?.name === "AbortError") return;
        setPreviewStatus("error");
        setPreviewError(e instanceof Error ? e.message : "Failed to load preview");
      }
    })();

    return () => controller.abort();
  }, [step, runId, runStatus?.status]);

  // When preview index or selection changes, fetch the selected HTML.
  useEffect(() => {
    if (step !== "done" || !runId) return;
    if (runStatus?.status !== "completed") return;
    const guide = previewGuides[previewIndex];
    if (!guide) return;

    const controller = new AbortController();
    setPreviewStatus((s) => (s === "loading-index" ? s : "loading-html"));
    setPreviewError(null);

    void (async () => {
      try {
        const resp = await fetch(
          `/api/runs/${encodeURIComponent(runId)}/preview?file=${encodeURIComponent(guide.outputFile)}`,
          { cache: "no-store", signal: controller.signal }
        );
        const text = await resp.text();
        if (!resp.ok) {
          let msg = text;
          try {
            const parsed = JSON.parse(text) as { error?: unknown };
            if (typeof parsed?.error === "string") msg = parsed.error;
          } catch {
            // ignore
          }
          throw new Error(msg || `Failed to load HTML (${resp.status})`);
        }
        setPreviewHtml(text);
        setPreviewStatus("ready");
      } catch (e) {
        if ((e as { name?: unknown } | null)?.name === "AbortError") return;
        setPreviewStatus("error");
        setPreviewError(e instanceof Error ? e.message : "Failed to load HTML");
      }
    })();

    return () => controller.abort();
  }, [step, runId, runStatus?.status, previewGuides, previewIndex]);

  // Reset per-run state when runId changes.
  useEffect(() => {
    if (!runId) return;
    if (lastRunIdRef.current === runId) return;
    lastRunIdRef.current = runId;
    setIsAiEditOpen(false);
    setAiInput("");
    setAiMessages([]);
    setAiError(null);
    setIsAiApplying(false);
    setAiProviderPref("auto");
    setHtmlVersionsByFile({});
    setSelectedVersionByFile({});
  }, [runId]);

  // Seed versions for the current previewed file (one timeline per outputFile).
  useEffect(() => {
    if (step !== "done" || !runId) return;
    if (runStatus?.status !== "completed") return;
    if (previewStatus !== "ready") return;
    const guide = previewGuides[previewIndex];
    if (!guide?.outputFile) return;
    const file = guide.outputFile;
    const initialId = "original";

    setHtmlVersionsByFile((cur) => {
      if (cur[file]?.length) return cur;
      return {
        ...cur,
        [file]: [
          {
            id: initialId,
            createdAt: Date.now(),
            label: "Original",
            html: previewHtml,
            source: "original",
          },
        ],
      };
    });
    setSelectedVersionByFile((cur) => (cur[file] ? cur : { ...cur, [file]: initialId }));
  }, [step, runId, runStatus?.status, previewStatus, previewGuides, previewIndex, previewHtml]);

  // Keep fullscreen state in sync with the browser.
  useEffect(() => {
    const onChange = () => {
      const el = previewFullscreenElRef.current;
      setIsPreviewFullscreen(!!el && document.fullscreenElement === el);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const togglePreviewFullscreen = useCallback(async () => {
    const el = previewFullscreenElRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch {
      // Ignore (fullscreen can be blocked by browser policy).
    }
  }, []);

  const currentGuide = previewGuides[previewIndex];
  const currentFile = currentGuide?.outputFile || "";
  const currentVersions = currentFile ? htmlVersionsByFile[currentFile] || [] : [];
  const selectedVersionId = currentFile ? selectedVersionByFile[currentFile] : undefined;
  const selectedVersion =
    currentVersions.find((v) => v.id === selectedVersionId) || currentVersions.at(-1) || null;
  const htmlToRender = selectedVersion?.html ?? previewHtml;
  const isOriginalSelected = (selectedVersion?.id || "original") === "original";

  const applyAiEdit = useCallback(async () => {
    if (!currentGuide?.outputFile) return;
    const instruction = aiInput.trim();
    if (!instruction) return;
    if (!selectedVersion) return;

    const file = currentGuide.outputFile;
    setAiError(null);
    setIsAiApplying(true);
    setAiInput("");
    setAiMessages((cur) => [...cur, { role: "user", content: instruction }]);

    try {
      const resp = await fetch("/api/html-edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: currentGuide.title,
          html: selectedVersion.html,
          instruction,
          provider: aiProviderPref,
        }),
      });
      const body: unknown = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg =
          typeof (body as { error?: unknown } | null)?.error === "string"
            ? (body as { error: string }).error
            : `AI edit failed (${resp.status})`;
        throw new Error(msg);
      }

      const nextHtml =
        typeof (body as { html?: unknown } | null)?.html === "string"
          ? ((body as { html: string }).html as string)
          : "";
      const summary =
        typeof (body as { summary?: unknown } | null)?.summary === "string"
          ? ((body as { summary: string }).summary as string)
          : "Applied changes";
      const providerUsed =
        typeof (body as { provider?: unknown } | null)?.provider === "string" &&
        (((body as { provider: string }).provider as string) === "openai" ||
          ((body as { provider: string }).provider as string) === "gemini")
          ? (((body as { provider: "openai" | "gemini" }).provider as unknown) as "openai" | "gemini")
          : null;

      if (!nextHtml.trim()) throw new Error("AI returned empty HTML");
      if (providerUsed) setAiProviderPref(providerUsed);

      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `v-${Date.now()}`;
      const v: HtmlVersion = {
        id,
        createdAt: Date.now(),
        label: summary.slice(0, 80),
        instruction,
        html: nextHtml,
        source: "llm",
      };

      setHtmlVersionsByFile((cur) => ({
        ...cur,
        [file]: [...(cur[file] || []), v],
      }));
      setSelectedVersionByFile((cur) => ({ ...cur, [file]: id }));
      setAiMessages((cur) => [
        ...cur,
        { role: "assistant", content: providerUsed ? `${summary} (${providerUsed})` : summary },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to apply AI edit";
      setAiError(msg);
      setAiMessages((cur) => [...cur, { role: "assistant", content: `Error: ${msg}` }]);
    } finally {
      setIsAiApplying(false);
    }
  }, [aiInput, currentGuide, selectedVersion]);

  return (
    <div
      className={cn(
        "relative p-6",
        step === "done"
          ? "border-0 bg-transparent shadow-none"
          : "rounded-xl border bg-card shadow-sm"
      )}
    >
      {isProcessing && (
        <div className="absolute right-4 top-4 inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground"
            aria-hidden="true"
          />
          <span>Working…</span>
        </div>
      )}
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
              <CardTitle>Step 4: Preview</CardTitle>
              <CardDescription>
                Preview the generated HTML. If multiple files were uploaded, use the arrows to
                switch between pages.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {previewStatus === "loading-index" && (
                <div className="text-sm text-muted-foreground">Loading preview…</div>
              )}
              {previewStatus === "error" && previewError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {previewError}
                </div>
              )}

              {previewGuides.length > 0 && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0 text-sm">
                      <span className="font-medium">{previewGuides[previewIndex]?.title}</span>{" "}
                      <span className="text-muted-foreground">
                        ({previewIndex + 1}/{previewGuides.length})
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setIsAiEditOpen((v) => !v)}
                        className={[
                          "rounded-md border px-3 py-2 text-sm font-medium",
                          isAiEditOpen
                            ? "border-blue-600 bg-blue-50 text-blue-700"
                            : "border-border bg-background hover:bg-muted",
                        ].join(" ")}
                        title="Open AI editor"
                      >
                        {isAiEditOpen ? "Close editor" : "AI edit"}
                      </button>

                      {isOriginalSelected ? (
                        <a
                          href={`/api/runs/${encodeURIComponent(runId || "")}/preview?file=${encodeURIComponent(
                            previewGuides[previewIndex]?.outputFile || ""
                          )}&download=1`}
                          className="inline-flex items-center justify-center rounded-md bg-black p-2 text-white hover:bg-black/90"
                          aria-label="Download this doc"
                          title="Download this doc"
                        >
                          <Download className="h-4 w-4" aria-hidden="true" />
                          <span className="sr-only">Download this doc</span>
                        </a>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            const title = currentGuide?.title || "Preview";
                            const full = wrapPreviewDoc(title, htmlToRender);
                            const safeName =
                              (currentGuide?.outputFile || "guide.html").replace(
                                /[^a-zA-Z0-9._-]/g,
                                "_"
                              ) || "guide.html";
                            downloadTextFile({
                              filename: safeName,
                              text: full,
                              mime: "text/html;charset=utf-8",
                            });
                          }}
                          className="inline-flex items-center justify-center rounded-md bg-black p-2 text-white hover:bg-black/90"
                          aria-label="Download this edited version"
                          title="Download this edited version"
                        >
                          <Download className="h-4 w-4" aria-hidden="true" />
                          <span className="sr-only">Download this edited version</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void togglePreviewFullscreen()}
                        className="inline-flex items-center justify-center rounded-md border border-border bg-background p-2 text-foreground hover:bg-muted"
                        aria-label={isPreviewFullscreen ? "Exit fullscreen" : "Fullscreen"}
                        title={isPreviewFullscreen ? "Exit fullscreen" : "Fullscreen"}
                      >
                        {isPreviewFullscreen ? (
                          <Minimize className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Maximize className="h-4 w-4" aria-hidden="true" />
                        )}
                        <span className="sr-only">
                          {isPreviewFullscreen ? "Exit fullscreen" : "Fullscreen"}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewIndex((i) => Math.max(0, i - 1))}
                        disabled={previewIndex <= 0}
                        className={[
                          "rounded-md border px-3 py-2 text-sm font-medium",
                          previewIndex <= 0
                            ? "cursor-not-allowed border-border bg-muted text-muted-foreground"
                            : "border-border bg-background hover:bg-muted",
                        ].join(" ")}
                      >
                        Prev
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setPreviewIndex((i) => Math.min(previewGuides.length - 1, i + 1))
                        }
                        disabled={previewIndex >= previewGuides.length - 1}
                        className={[
                          "rounded-md border px-3 py-2 text-sm font-medium",
                          previewIndex >= previewGuides.length - 1
                            ? "cursor-not-allowed border-border bg-muted text-muted-foreground"
                            : "border-border bg-background hover:bg-muted",
                        ].join(" ")}
                      >
                        Next
                      </button>
                    </div>
                  </div>

                  <div className="relative">
                    <div
                      ref={previewFullscreenElRef}
                      className="h-[520px] overflow-hidden rounded-md border bg-background"
                    >
                      <iframe
                        title={previewGuides[previewIndex]?.title || "Preview"}
                        className="h-full w-full"
                        sandbox=""
                        referrerPolicy="no-referrer"
                        srcDoc={wrapPreviewDoc(
                          previewGuides[previewIndex]?.title || "Preview",
                          htmlToRender
                        )}
                      />
                    </div>

                    {/* Lightbox editor: full-size artifact on the left + chat on the right */}
                    {isAiEditOpen && (
                      <>
                        <div
                          className="fixed inset-0 z-40 bg-black/40"
                          onClick={() => setIsAiEditOpen(false)}
                          aria-hidden="true"
                        />
                        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
                          <div
                            className="flex h-[calc(100vh-24px)] w-full max-w-6xl flex-col overflow-hidden rounded-xl border bg-background shadow-2xl sm:h-[calc(100vh-48px)]"
                            role="dialog"
                            aria-modal="true"
                            aria-label="AI editor"
                          >
                            <div className="flex items-center justify-between border-b px-4 py-3">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold">AI editor</div>
                                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                  {currentGuide?.title || "Preview"}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => setIsAiEditOpen(false)}
                                className="rounded-md border border-border bg-background p-2 hover:bg-muted"
                                aria-label="Close AI editor"
                              >
                                <X className="h-4 w-4" aria-hidden="true" />
                              </button>
                            </div>

                            <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-5">
                              {/* Left: full-size preview */}
                              <div className="min-h-0 border-b lg:col-span-3 lg:border-b-0 lg:border-r">
                                <div className="h-full min-h-0 p-3">
                                  <div className="h-full overflow-hidden rounded-md border bg-background">
                                    <iframe
                                      title={`${currentGuide?.title || "Preview"} (Editor)`}
                                      className="h-full w-full"
                                      sandbox=""
                                      referrerPolicy="no-referrer"
                                      srcDoc={wrapPreviewDoc(
                                        currentGuide?.title || "Preview",
                                        htmlToRender
                                      )}
                                    />
                                  </div>
                                </div>
                              </div>

                              {/* Right: controls + chat */}
                              <div className="flex min-h-0 flex-col lg:col-span-2">
                                <div className="border-b px-4 py-3">
                                  <div className="text-xs font-medium text-muted-foreground">
                                    Version
                                  </div>
                                  <div className="mt-2 flex items-center gap-2">
                                    <select
                                      className="h-10 w-full rounded-md border border-border bg-background px-2 text-sm"
                                      value={selectedVersion?.id || "original"}
                                      onChange={(e) => {
                                        const next = e.target.value;
                                        if (!currentFile) return;
                                        setSelectedVersionByFile((cur) => ({
                                          ...cur,
                                          [currentFile]: next,
                                        }));
                                      }}
                                      aria-label="Select version"
                                    >
                                      {currentVersions.map((v, idx) => (
                                        <option key={v.id} value={v.id}>
                                          {idx === 0 ? "Original" : `v${idx}`} — {v.label}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  <div className="mt-2 text-xs text-muted-foreground">
                                    {isOriginalSelected ? "Original" : "Edited"}
                                  </div>
                                </div>

                                <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
                                  <div className="text-xs font-medium text-muted-foreground">
                                    Chat
                                  </div>
                                  {aiError && (
                                    <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                      {aiError}
                                    </div>
                                  )}
                                  <div className="mt-2 min-h-0 flex-1 overflow-auto rounded-md border bg-muted/10 p-2 text-sm">
                                    {aiMessages.length === 0 ? (
                                      <div className="text-xs text-muted-foreground">
                                        Ask for changes like “Add icons for key actions” or “Make this more scannable with clearer sections.”
                                      </div>
                                    ) : (
                                      <div className="space-y-3">
                                        {aiMessages.slice(-50).map((m, i) => (
                                          <div
                                            key={i}
                                            className={cn(
                                              "flex",
                                              m.role === "user" ? "justify-end" : "justify-start"
                                            )}
                                          >
                                            <div
                                              className={cn(
                                                "max-w-[92%] rounded-lg px-3 py-2 text-sm",
                                                m.role === "user"
                                                  ? "bg-blue-600 text-white"
                                                  : "bg-background text-foreground border"
                                              )}
                                            >
                                              <div className="whitespace-pre-wrap break-words">
                                                {m.content}
                                              </div>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </div>

                                <div className="border-t px-4 py-3">
                                  <div className="flex items-end gap-2">
                                    <textarea
                                      value={aiInput}
                                      onChange={(e) => setAiInput(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter" && !e.shiftKey) {
                                          e.preventDefault();
                                          void applyAiEdit();
                                        }
                                      }}
                                      rows={3}
                                      placeholder="Message…"
                                      className="w-full resize-none rounded-md border border-border bg-background p-2 text-sm"
                                      disabled={isAiApplying}
                                    />
                                    <button
                                      type="button"
                                      onClick={() => void applyAiEdit()}
                                      disabled={isAiApplying || !aiInput.trim()}
                                      className={[
                                        "h-10 shrink-0 rounded-md px-3 text-sm font-medium",
                                        isAiApplying || !aiInput.trim()
                                          ? "cursor-not-allowed bg-muted text-muted-foreground"
                                          : "bg-blue-600 text-white hover:bg-blue-700",
                                      ].join(" ")}
                                    >
                                      {isAiApplying ? "Sending…" : "Send"}
                                    </button>
                                  </div>
                                  <div className="mt-1 text-[11px] text-muted-foreground">
                                    Enter to send • Shift+Enter for a new line
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {previewGuides.length === 0 && previewStatus !== "loading-index" && (
                <div className="text-sm text-muted-foreground">No preview available.</div>
              )}
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
            setShowErrorLightbox(false);
            setErrorMessage(null);
          }}
        />
      )}
    </div>
  );
}

