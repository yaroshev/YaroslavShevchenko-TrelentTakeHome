import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { marked } from "marked";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { ensureDir, getUploadsDir, safeJoin } from "@/server/storage";
import type { RunState } from "@/server/run-store";
import { createLogger, errorToObject, maskSecret, type Logger } from "@/server/logger";

export type PipelineProgressUpdate = {
  progress: number;
  message?: string;
  currentFile?: string;
  currentIndex?: number;
  totalFiles?: number;
  stage?: "reading" | "converting" | "writing" | "zipping";
};

function extLower(p: string) {
  return path.extname(p).toLowerCase();
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeHtmlFragment(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return "";

  // If a model returns a full document, try to extract the body contents.
  const bodyMatch = trimmed.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) return bodyMatch[1].trim();

  // Strip outer <html> wrapper if present.
  const htmlMatch = trimmed.match(/<html[^>]*>([\s\S]*?)<\/html>/i);
  if (htmlMatch?.[1]) return htmlMatch[1].trim();

  return trimmed;
}

const SUPPORT_MESSAGE = "Something went wrong please contact support or retry";
const EXPOSE_PROVIDER_ERRORS = process.env.DEBUG_EXPOSE_PROVIDER_ERRORS === "1";
const GEMINI_MIN_DELAY_MS = Number(process.env.GEMINI_MIN_DELAY_MS || 1200);

function isLikelyRateLimitError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b429\b/.test(msg) || /rate\s*limit/i.test(msg) || /quota/i.test(msg) || /too\s+many\s+requests/i.test(msg);
}

function isLikelyAuthOrBadRequest(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  // Generally not worth retrying (will never succeed until config changes).
  return /\b(400|401|403|404)\b/.test(msg) || /invalid/i.test(msg) || /not\s+found/i.test(msg);
}

function isGeminiQuotaOrBillingError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  // Generative Language API often returns 429 for "quota/billing" as well as "rate limit".
  // We treat this as "try a different model if available" (some models are free-tier eligible).
  return /\b429\b/.test(msg) && /quota|billing|plan/i.test(msg);
}

// Gemini free-tier protection: ensure requests are serialized + spaced out.
let geminiQueue: Promise<void> = Promise.resolve();
let geminiLastStartedAt = 0;
async function scheduleGeminiRequest<T>(fn: () => Promise<T>): Promise<T> {
  let out: T | undefined;
  let err: unknown = null;

  geminiQueue = geminiQueue.then(async () => {
    const waitMs = Math.max(0, geminiLastStartedAt + GEMINI_MIN_DELAY_MS - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    geminiLastStartedAt = Date.now();
    try {
      out = await fn();
    } catch (e) {
      err = e;
    }
  });

  await geminiQueue;
  if (err) throw err;
  if (typeof out === "undefined") throw new Error("Gemini request scheduling failed");
  return out;
}

async function sleep(ms: number) {
  await new Promise<void>((r) => setTimeout(r, ms));
}

async function trelentIngestionToMarkdown(filePath: string, log?: Logger): Promise<string> {
  const base = process.env.DATA_INGESTION_API_URL;
  const token = process.env.DATA_INGESTION_API_TOKEN;
  if (!base || !token) {
    log?.error("ingestion: missing env vars", {
      hasDATA_INGESTION_API_URL: !!base,
      hasDATA_INGESTION_API_TOKEN: !!token,
    });
    throw new Error(EXPOSE_PROVIDER_ERRORS ? "Missing DATA_INGESTION_API_URL / DATA_INGESTION_API_TOKEN" : SUPPORT_MESSAGE);
  }

  /**
   * IMPORTANT:
   * The real Trelent ingestion endpoint(s) should come from docs/SDK. To keep this take-home runnable
   * even if the endpoint changes, we allow overriding the exact URLs via env var.
   *
   * - DATA_INGESTION_CONVERT_URLS: comma-separated list of absolute URLs to try in order.
   *   Example:
   *     DATA_INGESTION_CONVERT_URLS="https://api.trelent.com/v1/<correct-path>,https://api.trelent.com/v1/<alt-path>"
   *
   * If not provided, we fall back to a small set of plausible endpoints (may 404).
   */
  const overrideUrlsRaw = (process.env.DATA_INGESTION_CONVERT_URLS || "").trim();
  const overrideUrls = overrideUrlsRaw
    ? overrideUrlsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // Default candidates (best effort). If none work, we surface a generic support message.
  const candidates = overrideUrls.length
    ? overrideUrls
    : [
        new URL("/v1/ingestion/file/convert", base).toString(),
        new URL("/v1/ingestion/convert", base).toString(),
        new URL("/ingestion/file/convert", base).toString(),
        new URL("/ingestion/convert", base).toString(),
      ];

  const fileBuf = await fs.readFile(filePath);
  const fileName = path.basename(filePath);
  log?.info("ingestion: start", {
    fileName,
    base,
    token: maskSecret(token),
    candidatesCount: candidates.length,
    candidatesSource: overrideUrls.length ? "env:DATA_INGESTION_CONVERT_URLS" : "default",
  });

  const tryOnce = async (url: string, attempt: number, endpointType: "primary" | "fallback") => {
    const startedAt = Date.now();
    const form = new FormData();
    form.append("file", new Blob([fileBuf]), fileName);
    form.append("output", "markdown");

    console.log(`[API Call] Ingestion API ${endpointType.toUpperCase()} - Attempt ${attempt}/3 - URL: ${url}`);
    log?.info("ingestion: attempt start", {
      attempt,
      maxAttempts: 3,
      url,
      endpointType,
      fileName,
      fileBytes: fileBuf.byteLength,
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
      },
      body: form,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[API Call] Ingestion API ${endpointType.toUpperCase()} - ❌ FAILED - Attempt ${attempt}/3 - Status: ${res.status} - URL: ${url}`);
      log?.warn("ingestion: endpoint failed", {
        attempt,
        url,
        endpointType,
        status: res.status,
        durationMs: Date.now() - startedAt,
        bodySnippet: text.slice(0, 300),
      });
      throw new Error(`Ingestion API error ${res.status}: ${text.slice(0, 300)}`);
    }

    const json: unknown = await res.json().catch(() => null);
    const pick = (obj: unknown, key: string) =>
      typeof (obj as Record<string, unknown> | null)?.[key] === "string"
        ? ((obj as Record<string, unknown>)[key] as string)
        : null;

    const asRecord = (v: unknown) =>
      v && typeof v === "object" ? (v as Record<string, unknown>) : null;

    const possible =
      pick(json, "markdown") ??
      pick(json, "content") ??
      pick(asRecord(json)?.data, "markdown") ??
      pick(asRecord(json)?.data, "content") ??
      pick(asRecord(json)?.result, "markdown") ??
      pick(asRecord(json)?.result, "content");

    if (typeof possible !== "string" || possible.trim().length === 0) {
      console.error(`[API Call] Ingestion API ${endpointType.toUpperCase()} - ❌ FAILED - Attempt ${attempt}/3 - No markdown content - URL: ${url}`);
      log?.warn("ingestion: endpoint returned no markdown", {
        attempt,
        url,
        endpointType,
        durationMs: Date.now() - startedAt,
      });
      throw new Error("Ingestion API response did not include markdown content");
    }

    console.log(`[API Call] Ingestion API ${endpointType.toUpperCase()} - ✅ SUCCESS - Attempt ${attempt}/3 - URL: ${url}`);
    log?.info("ingestion: endpoint success", {
      attempt,
      url,
      endpointType,
      durationMs: Date.now() - startedAt,
      markdownChars: possible.length,
    });
    return possible as string;
  };

  // Primary API: first endpoint with 3 retries
  const primaryUrl = candidates[0];
  const fallbackUrls = candidates.slice(1);
  
  console.log(`\n[API Call] ========================================`);
  console.log(`[API Call] INGESTION API - PRIMARY ENDPOINT`);
  console.log(`[API Call] Starting Ingestion API - Primary: ${primaryUrl}`);
  console.log(`[API Call] ========================================\n`);
  
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await tryOnce(primaryUrl, attempt, "primary");
    } catch (e) {
      lastErr = e;
      console.log(`[API Call] Ingestion API PRIMARY - Attempt ${attempt}/3 failed, retrying...`);
      log?.warn("ingestion: primary attempt failed", {
        attempt,
        maxAttempts: 3,
        url: primaryUrl,
        error: errorToObject(e),
      });
      if (attempt < 3) {
        await sleep(400 * attempt);
      }
    }
  }

  // Fallback APIs: try each fallback endpoint with 3 retries each
  console.error(`\n[API Call] ========================================`);
  console.error(`[API Call] INGESTION API PRIMARY FAILED after 3 attempts`);
  console.error(`[API Call] Trying ${fallbackUrls.length} fallback endpoint(s)...`);
  console.error(`[API Call] ========================================\n`);
  log?.warn("ingestion: primary failed after 3 attempts; trying fallback endpoints", {
    primaryUrl,
    fallbackCount: fallbackUrls.length,
  });

  for (const fallbackUrl of fallbackUrls) {
    console.log(`[API Call] Starting Ingestion API FALLBACK - URL: ${fallbackUrl}`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await tryOnce(fallbackUrl, attempt, "fallback");
      } catch (e) {
        lastErr = e;
        console.log(`[API Call] Ingestion API FALLBACK - Attempt ${attempt}/3 failed - URL: ${fallbackUrl}`);
        log?.warn("ingestion: fallback attempt failed", {
          attempt,
          maxAttempts: 3,
          url: fallbackUrl,
          error: errorToObject(e),
        });
        if (attempt < 3) {
          await sleep(400 * attempt);
        }
      }
    }
    console.log(`[API Call] Ingestion API FALLBACK endpoint exhausted - URL: ${fallbackUrl}`);
  }
  
  console.error(`\n[API Call] ========================================`);
  console.error(`[API Call] INGESTION API - ALL ATTEMPTS FAILED`);
  console.error(`[API Call] Primary + ${fallbackUrls.length} fallback(s) exhausted`);
  console.error(`[API Call] FAILING ENTIRE RUN`);
  console.error(`[API Call] ========================================\n`);
  log?.error("ingestion: all endpoints failed", { 
    primaryUrl,
    fallbackUrls,
    error: errorToObject(lastErr) 
  });
  throw new Error(EXPOSE_PROVIDER_ERRORS ? "Ingestion API: no endpoints worked" : SUPPORT_MESSAGE);
}

function stripHtmlToText(html: string) {
  // Lightweight HTML -> text fallback (good enough for "keep the run working").
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replaceAll("&nbsp;", " ")
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

async function localToMarkdown(filePath: string, log?: Logger): Promise<string> {
  const ext = extLower(filePath);
  const fileName = path.basename(filePath);
  const buf = await fs.readFile(filePath);

  try {
    if (ext === ".md" || ext === ".markdown") return buf.toString("utf8");
    if (ext === ".txt" || ext === ".log" || ext === ".csv" || ext === ".tsv") return buf.toString("utf8");

    if (ext === ".json") {
      const raw = buf.toString("utf8");
      try {
        return "```json\n" + JSON.stringify(JSON.parse(raw), null, 2) + "\n```";
      } catch {
        return raw;
      }
    }

    if (ext === ".pdf") {
      const parsed = await pdfParse(buf);
      const text = (parsed.text || "").trim();
      if (text) return text;
      throw new Error("pdf-parse returned empty text");
    }

    if (ext === ".docx") {
      const result = await mammoth.extractRawText({ buffer: buf });
      const text = (result?.value || "").trim();
      if (text) return text;
      throw new Error("mammoth returned empty text");
    }

    if (ext === ".html" || ext === ".htm") {
      const html = buf.toString("utf8");
      const text = stripHtmlToText(html);
      return text || html;
    }

    // Best effort: decode as UTF-8.
    return buf.toString("utf8");
  } catch (e) {
    log?.warn("localToMarkdown: failed; falling back to utf8 decode", {
      fileName,
      ext,
      error: errorToObject(e),
    });
    return buf.toString("utf8");
  }
}

async function toMarkdown(filePath: string, log?: Logger) {
  // Prefer ingestion API when configured, but always allow local fallback so runs succeed
  // even when offline or misconfigured.
  const hasIngestion = !!(process.env.DATA_INGESTION_API_URL && process.env.DATA_INGESTION_API_TOKEN);
  if (!hasIngestion) {
    log?.info("toMarkdown: ingestion not configured; using local conversion", {
      hasDATA_INGESTION_API_URL: !!process.env.DATA_INGESTION_API_URL,
      hasDATA_INGESTION_API_TOKEN: !!process.env.DATA_INGESTION_API_TOKEN,
    });
    return await localToMarkdown(filePath, log);
  }

  try {
    return await trelentIngestionToMarkdown(filePath, log);
  } catch (e) {
    log?.warn("toMarkdown: ingestion failed; using local conversion fallback", {
      error: errorToObject(e),
    });
    return await localToMarkdown(filePath, log);
  }
}

async function rewriteToHtmlFragment(
  title: string,
  markdown: string,
  log?: Logger,
  opts?: {
    preferredPrimary?: "openai" | "gemini";
    /**
     * Called once the primary provider fails (after its internal retries),
     * so the caller can make fallback "sticky" for the remainder of a run.
     */
    onPrimaryFailure?: (info: { provider: "openai" | "gemini"; error: unknown }) => void;
  }
) {
  const localMarkdownToHtml = () => {
    const body = String(marked.parse(markdown || "")) || "";
    return normalizeHtmlFragment(
      `<article data-generator="local-fallback">
<h1>${escapeHtml(title)}</h1>
${body}
</article>`
    );
  };

  const system =
    "You rewrite internal guides into clean, modern HTML for non-technical users. " +
    "Output only an HTML fragment (no <html>, no <head>, no <body>). " +
    "Use short sections, clear headings, and simple lists. " +
    "Do not include code fences. Do not include markdown.";

  const prompt =
    `Title: ${title}\n\n` +
    "Convert the content below into polished HTML that follows a consistent guide template.\n\n" +
    "Content:\n" +
    markdown;

  const retrying = async (opts: {
    provider: "openai" | "gemini";
    maxAttempts: number;
    apiType: "primary" | "fallback";
    onAttempt: (attempt: number) => Promise<string>;
  }) => {
    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt < opts.maxAttempts) {
      attempt++;
      try {
        return await opts.onAttempt(attempt);
      } catch (e) {
        lastErr = e;
        // Don't amplify 429s (free-tier quotas) or auth/config errors with retries.
        // For OpenAI 429, we want to fail fast and switch to Gemini fallback.
        if (isLikelyRateLimitError(e) || isLikelyAuthOrBadRequest(e)) {
          throw e;
        }
        console.log(`[API Call] ${opts.provider.toUpperCase()} ${opts.apiType.toUpperCase()} - Attempt ${attempt}/${opts.maxAttempts} failed, retrying...`);
        log?.warn("rewrite: attempt failed", {
          provider: opts.provider,
          apiType: opts.apiType,
          attempt,
          maxAttempts: opts.maxAttempts,
          error: errorToObject(e),
        });
        if (attempt < opts.maxAttempts) {
          await sleep(400 * attempt);
        }
      }
    }
    console.error(`[API Call] ${opts.provider.toUpperCase()} ${opts.apiType.toUpperCase()} - ❌ FAILED after ${opts.maxAttempts} attempts`);
    throw lastErr instanceof Error ? lastErr : new Error(`${opts.provider} ${opts.apiType} rewrite failed`);
  };

  const tryOpenAi = async (apiType: "primary" | "fallback"): Promise<string> => {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

    return await retrying({
      provider: "openai",
      apiType,
      maxAttempts: 3,
      onAttempt: async (attempt) => {
        const startedAt = Date.now();
        console.log(`[API Call] OpenAI ${apiType} - Attempt ${attempt}/3 - Model: gpt-5.1-mini`);
        log?.info("rewrite: attempt start", {
          provider: "openai",
          apiType,
          api: "openai (via Vercel AI SDK)",
          attempt,
          maxAttempts: 3,
          model: "gpt-5.1-mini",
          title,
          markdownChars: markdown.length,
        });
        try {
          const result = await generateText({
            model: openai("gpt-5.1-mini"),
            system,
            prompt: `${prompt}\n\nReturn only an HTML fragment.`,
          });
          const html = normalizeHtmlFragment(result.text || "");
          if (!html) throw new Error("Empty model output");
          console.log(`[API Call] OpenAI ${apiType.toUpperCase()} - ✅ SUCCESS - Attempt ${attempt}/3`);
          log?.info("rewrite: attempt success", {
            provider: "openai",
            apiType,
            attempt,
            durationMs: Date.now() - startedAt,
            htmlChars: html.length,
          });
          return html;
        } catch (e) {
          console.error(`[API Call] OpenAI ${apiType.toUpperCase()} - ❌ FAILED - Attempt ${attempt}/3 - Error: ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        }
      },
    });
  };

  const tryGemini = async (apiType: "primary" | "fallback"): Promise<string> => {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    const keySource = process.env.GEMINI_API_KEY
      ? "GEMINI_API_KEY"
      : process.env.GOOGLE_API_KEY
        ? "GOOGLE_API_KEY"
        : null;
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");

    type GeminiModel = {
      name?: string;
      supportedGenerationMethods?: string[];
      displayName?: string;
    };

    const configuredModel = process.env.GEMINI_MODEL || null;
    const configuredVersion = (process.env.GEMINI_API_VERSION as "v1" | "v1beta" | undefined) || null;

    const listModels = async (version: "v1" | "v1beta") => {
      const url = new URL(`/${version}/models`, "https://generativelanguage.googleapis.com");
      url.searchParams.set("key", apiKey);
      const res = await fetch(url.toString(), { method: "GET" });
      const txt = await res.text().catch(() => "");
      if (!res.ok) throw new Error(`ListModels ${version} failed ${res.status}: ${txt.slice(0, 300)}`);
      const json: unknown = JSON.parse(txt);
      return ((json as { models?: GeminiModel[] })?.models || []).filter(Boolean);
    };

    const pickBestModel = (models: GeminiModel[]) => {
      const supports = (m: GeminiModel, method: string) => (m.supportedGenerationMethods || []).includes(method);
      const name = (m: GeminiModel) => m.name || "";
      const eligible = models.filter((m) => supports(m, "generateContent"));
      const byPref = (prefs: RegExp[]) => eligible.find((m) => prefs.every((re) => re.test(name(m)))) || null;
      return (
        // Prefer 2.5 Flash-Lite first (we've observed some keys get 429 on 2.0 flash-lite while 2.5 works)
        byPref([/gemini/i, /2\.5/i, /flash/i, /lite/i]) ||
        // Then 2.5 Flash
        byPref([/gemini/i, /2\.5/i, /flash/i]) ||
        // Then other Flash-Lite variants
        byPref([/gemini/i, /flash/i, /lite/i]) ||
        // Then prefer newer flash models
        // Then prefer newer flash models
        byPref([/gemini/i, /2\./i, /flash/i]) ||
        byPref([/gemini/i, /1\./i, /flash/i]) ||
        eligible[0] ||
        null
      );
    };

    let version: "v1" | "v1beta" = configuredVersion || "v1";
    let model = configuredModel;
    let modelSource: "env" | "autodetect" = configuredModel ? "env" : "autodetect";

    if (!model) {
      try {
        const models = await listModels(version);
        const best = pickBestModel(models);
        model = best?.name?.replace(/^models\//, "") || null;
      } catch {
        version = "v1beta";
        const models = await listModels(version);
        const best = pickBestModel(models);
        model = best?.name?.replace(/^models\//, "") || null;
      }
    }

    if (!model) throw new Error("No Gemini model found that supports generateContent");

    const callWith = async (m: string, v: "v1" | "v1beta", src: "env" | "autodetect") => {
      const url = new URL(`/${v}/models/${encodeURIComponent(m)}:generateContent`, "https://generativelanguage.googleapis.com");
      url.searchParams.set("key", apiKey);
      const maxAttempts = 2;
      return await retrying({
        provider: "gemini",
        apiType,
        // Free tier is extremely sensitive to burst traffic; keep retries low.
        maxAttempts,
        onAttempt: async (attempt) => {
        const startedAt = Date.now();
        console.log(`[API Call] Gemini ${apiType.toUpperCase()} - Attempt ${attempt}/${maxAttempts} - Model: ${m}`);
        log?.info("rewrite: attempt start", {
          provider: "gemini",
          apiType,
          api: "Google Generative Language API",
          url: url.toString(),
          attempt,
          maxAttempts,
          model: m,
          version: v,
          modelSource: src,
          configuredModel,
          configuredVersion,
          keySource,
          apiKey: maskSecret(apiKey),
          title,
          markdownChars: markdown.length,
        });

        try {
          const res = await scheduleGeminiRequest(() =>
            fetch(url.toString(), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                contents: [
                  {
                    role: "user",
                    parts: [
                      {
                        text:
                          `${system}\n\n` +
                          `${prompt}\n\n` +
                          "Return only an HTML fragment. No markdown. No code fences.",
                      },
                    ],
                  },
                ],
                generationConfig: { temperature: 0.2 },
              }),
            })
          );

          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            console.error(`[API Call] Gemini ${apiType} - FAILED - Attempt ${attempt}/${maxAttempts} - Status: ${res.status}`);
            throw new Error(`Gemini error ${res.status}: ${txt.slice(0, 300)}`);
          }

          const json: unknown = await res.json().catch(() => null);
          const candidates =
            (json as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })
              ?.candidates || [];
          const text = candidates
            .flatMap((c) => c.content?.parts || [])
            .map((p) => (typeof p.text === "string" ? p.text : ""))
            .join("\n")
            .trim();

          const html = normalizeHtmlFragment(text);
          if (!html) {
            console.error(
              `[API Call] Gemini ${apiType.toUpperCase()} - ❌ FAILED - Attempt ${attempt}/${maxAttempts} - Empty output`
            );
            throw new Error("Empty Gemini output");
          }
          console.log(`[API Call] Gemini ${apiType} - SUCCESS - Attempt ${attempt}/${maxAttempts}`);
          log?.info("rewrite: attempt success", {
            provider: "gemini",
            apiType,
            attempt,
            durationMs: Date.now() - startedAt,
            htmlChars: html.length,
          });
          return html;
        } catch (e) {
          console.error(`[API Call] Gemini ${apiType.toUpperCase()} - ❌ FAILED - Attempt ${attempt}/${maxAttempts} - Error: ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        }
        },
      });
    };

    // First try the chosen model (env or autodetected).
    try {
      return await callWith(model, version, modelSource);
    } catch (e) {
      // If the model was forced via env and appears quota-blocked, try a different eligible model.
      if (modelSource === "env" && (isGeminiQuotaOrBillingError(e) || isLikelyAuthOrBadRequest(e))) {
        log?.warn("rewrite: gemini configured model failed; trying autodetect alternative", {
          configuredModel,
          configuredVersion,
          error: errorToObject(e),
        });
        try {
          let v: "v1" | "v1beta" = configuredVersion || "v1";
          let alt: string | null = null;
          try {
            const models = await listModels(v);
            const best = pickBestModel(models);
            alt = best?.name?.replace(/^models\//, "") || null;
          } catch {
            v = "v1beta";
            const models = await listModels(v);
            const best = pickBestModel(models);
            alt = best?.name?.replace(/^models\//, "") || null;
          }
          if (alt && alt !== configuredModel) {
            log?.info("rewrite: gemini switching models", {
              from: configuredModel,
              to: alt,
              version: v,
            });
            return await callWith(alt, v, "autodetect");
          }
        } catch (e2) {
          log?.warn("rewrite: gemini alternative model attempt failed", { error: errorToObject(e2) });
        }
      }
      throw e;
    }
  };

  log?.info("rewrite: selecting engine", {
    hasOpenAi: !!process.env.OPENAI_API_KEY,
    hasGemini: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
  });

  const hasOpenAi = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  if (!hasOpenAi && !hasGemini) {
    log?.warn("rewrite: no LLM API configured; using local markdown->HTML fallback", {
      hasOpenAi,
      hasGemini,
    });
    return localMarkdownToHtml();
  }

  // Prefer OpenAI as primary when configured, with Gemini as fallback (or vice versa).
  // Optionally allow the caller to make the preference "sticky" for a run.
  const defaultPrimary: "openai" | "gemini" = hasOpenAi ? "openai" : "gemini";
  const preferred = opts?.preferredPrimary;
  const primary: "openai" | "gemini" =
    preferred && ((preferred === "openai" && hasOpenAi) || (preferred === "gemini" && hasGemini))
      ? preferred
      : defaultPrimary;
  const fallback: "openai" | "gemini" = primary === "openai" ? "gemini" : "openai";

  const callProvider = async (provider: "openai" | "gemini", apiType: "primary" | "fallback") => {
    if (provider === "openai") return await tryOpenAi(apiType);
    return await tryGemini(apiType);
  };

  let primaryErr: unknown = null;
  try {
    console.log(`\n[API Call] ========================================`);
    console.log(`[API Call] PRIMARY API: ${primary.toUpperCase()}`);
    console.log(`[API Call] Starting rewrite with PRIMARY API: ${primary}`);
    console.log(`[API Call] ========================================\n`);
    log?.info("rewrite: calling primary api", { provider: primary });
    return await callProvider(primary, "primary");
  } catch (e) {
    primaryErr = e;
    opts?.onPrimaryFailure?.({ provider: primary, error: e });
    console.error(`\n[API Call] ========================================`);
    console.error(`[API Call] PRIMARY API (${primary.toUpperCase()}) FAILED after 3 attempts`);
    console.error(`[API Call] Switching to FALLBACK API: ${fallback.toUpperCase()}`);
    console.error(`[API Call] ========================================\n`);
    log?.warn("rewrite: primary api failed; switching to fallback api", {
      provider: primary,
      error: errorToObject(e),
    });
  }

  try {
    console.log(`\n[API Call] ========================================`);
    console.log(`[API Call] FALLBACK API: ${fallback.toUpperCase()}`);
    console.log(`[API Call] Starting rewrite with FALLBACK API: ${fallback}`);
    console.log(`[API Call] ========================================\n`);
    log?.info("rewrite: calling fallback api", { provider: fallback });
    return await callProvider(fallback, "fallback");
  } catch (e) {
    console.error(`\n[API Call] ========================================`);
    console.error(`[API Call] FALLBACK API (${fallback.toUpperCase()}) FAILED after 3 attempts`);
    console.error(`[API Call] ALL APIs EXHAUSTED - Failing entire run`);
    console.error(`[API Call] ========================================\n`);
    log?.error("rewrite: fallback api failed; surfacing support message", {
      primaryProvider: primary,
      primaryError: errorToObject(primaryErr),
      fallbackProvider: fallback,
      fallbackError: errorToObject(e),
    });
    log?.warn("rewrite: all LLMs failed; using local markdown->HTML fallback", {
      primaryProvider: primary,
      primaryError: errorToObject(primaryErr),
      fallbackProvider: fallback,
      fallbackError: errorToObject(e),
    });
    return localMarkdownToHtml();
  }
}

function makeUniqueOutputHtmlName(baseNameNoExt: string, used: Map<string, number>) {
  const safeBase = (baseNameNoExt || "file").trim() || "file";
  const base = `${safeBase}.html`;
  const count = used.get(base) ?? 0;
  if (count === 0) {
    used.set(base, 1);
    return base;
  }
  const next = count + 1;
  used.set(base, next);
  return `${safeBase} (${next}).html`;
}

async function zipDirectoryToFile(sourceDir: string, zipPath: string) {
  await ensureDir(path.dirname(zipPath));
  await new Promise<void>((resolve, reject) => {
    const output = fssync.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize().catch(reject);
  });
}

export async function runPipeline(
  run: Extract<RunState, { status: "queued" | "running" }> & { status: "running" },
  onProgress: (u: PipelineProgressUpdate) => Promise<void>
) {
  const log = createLogger("pipeline", { runId: run.runId, uploadId: run.uploadId });
  log.info("runPipeline: start", {
    cwd: process.cwd(),
    env: {
      hasOPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      hasGEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      hasGOOGLE_API_KEY: !!process.env.GOOGLE_API_KEY,
      GEMINI_MODEL: process.env.GEMINI_MODEL || null,
      hasDATA_INGESTION_API_URL: !!process.env.DATA_INGESTION_API_URL,
      hasDATA_INGESTION_API_TOKEN: !!process.env.DATA_INGESTION_API_TOKEN,
      DATA_INGESTION_API_URL: process.env.DATA_INGESTION_API_URL || null,
      DATA_INGESTION_API_TOKEN: maskSecret(process.env.DATA_INGESTION_API_TOKEN),
    },
  });

  const uploadDir = path.join(getUploadsDir(), run.uploadId);
  const inputDir = path.join(uploadDir, "input");
  const outDir = path.join(uploadDir, "output", run.runId);
  const guidesDir = path.join(outDir, "guides");
  await ensureDir(guidesDir);

  const walk = async (dir: string, prefix = ""): Promise<string[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      const rel = `${prefix}${e.name}`;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        files.push(...(await walk(full, `${rel}/`)));
      } else if (e.isFile()) {
        files.push(rel);
      }
    }
    return files;
  };

  const relFiles = await walk(inputDir);
  if (relFiles.length === 0) {
    throw new Error("No uploaded files found");
  }
  log.info("runPipeline: discovered input files", { inputDir, count: relFiles.length, relFiles });

  await onProgress({
    progress: 5,
    message: "Reading files...",
    stage: "reading",
    currentIndex: 0,
    totalFiles: relFiles.length,
  });

  const per = 80 / relFiles.length;
  let idx = 0;

  // Sticky LLM preference: if the primary provider fails once (e.g. broken OpenAI key),
  // keep using the fallback for the rest of this run rather than "cycling back" per file.
  const hasOpenAi = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  let preferredRewriteProvider: "openai" | "gemini" | null =
    hasOpenAi ? "openai" : hasGemini ? "gemini" : null;
  const usedOutputNames = new Map<string, number>();
  const manifest: Array<{
    sourcePath: string;
    outputFile: string;
    title: string;
    status: "ok" | "error";
    error?: string;
  }> = [];

  for (const rel of relFiles) {
    idx++;
    const inputPath = safeJoin(inputDir, rel);
    const title = path.basename(rel);
    const baseNoExt = path.basename(rel, path.extname(rel));
    const outName = makeUniqueOutputHtmlName(baseNoExt, usedOutputNames);
    const fileLog = createLogger("pipeline.file", {
      runId: run.runId,
      uploadId: run.uploadId,
      sourcePath: rel,
      inputPath,
      outputFile: outName,
    });

    const desiredOutName = `${((baseNoExt || "file").trim() || "file")}.html`;
    if (outName !== desiredOutName) {
      fileLog.warn("output name collision; applied suffix", {
        desiredOutName,
        finalOutName: outName,
      });
    }

    try {
      const st = await fs.stat(inputPath);
      fileLog.info("file: start", {
        sizeBytes: st.size,
        ext: extLower(inputPath),
        baseNoExt,
      });
    } catch (e) {
      fileLog.warn("file: could not stat input file", { error: errorToObject(e) });
    }

    await onProgress({
      progress: Math.round(5 + per * (idx - 1)),
      message: `Converting ${title}`,
      stage: "converting",
      currentFile: title,
      currentIndex: idx,
      totalFiles: relFiles.length,
    });

    try {
      const md = await toMarkdown(inputPath, fileLog);
      fileLog.info("file: markdown ready", { markdownChars: md.length });
      const html = await rewriteToHtmlFragment(title, md, fileLog, {
        preferredPrimary: preferredRewriteProvider || undefined,
        onPrimaryFailure: ({ provider, error }) => {
          // If both are available, flip preference so we don't keep retrying the failing one.
          if (!hasOpenAi || !hasGemini) return;
          if (preferredRewriteProvider !== provider) return;
          preferredRewriteProvider = provider === "openai" ? "gemini" : "openai";
          fileLog.warn("rewrite: primary failed; making fallback sticky for remainder of run", {
            failedProvider: provider,
            nextPreferred: preferredRewriteProvider,
            error: errorToObject(error),
          });
        },
      });
      fileLog.info("file: html ready", { htmlChars: html.length });
      await fs.writeFile(path.join(guidesDir, outName), html, "utf8");
      manifest.push({
        sourcePath: rel,
        outputFile: outName,
        title,
        status: "ok",
      });
      fileLog.info("file: wrote output", { guidesDir });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Conversion failed";
      fileLog.error("file: conversion failed", { error: errorToObject(e) });
      
      // If all APIs failed after retries (SUPPORT_MESSAGE), fail the entire run instead of just this file
      // Check both exact match and if message contains SUPPORT_MESSAGE (in case of wrapped errors)
      if (msg === SUPPORT_MESSAGE || msg.includes(SUPPORT_MESSAGE)) {
        console.error(`\n[Pipeline] ========================================`);
        console.error(`[Pipeline] CRITICAL API FAILURE for file "${rel}"`);
        console.error(`[Pipeline] Error: ${msg}`);
        console.error(`[Pipeline] FAILING ENTIRE RUN - No error HTML will be generated`);
        console.error(`[Pipeline] ========================================\n`);
        log.error("pipeline: critical API failure - failing entire run", {
          file: rel,
          error: errorToObject(e),
        });
        throw e; // Re-throw to fail the entire pipeline
      }
      
      // For other errors, write error HTML and continue with other files
      console.warn(`[Pipeline] Non-critical error for file "${rel}": ${msg}. Writing error HTML and continuing.`);
      const html = `<h2>Conversion failed</h2>
<p><strong>File:</strong> ${escapeHtml(rel)}</p>
<p><strong>Error:</strong> ${escapeHtml(msg)}</p>`;
      await fs.writeFile(path.join(guidesDir, outName), html, "utf8");
      manifest.push({
        sourcePath: rel,
        outputFile: outName,
        title,
        status: "error",
        error: msg,
      });
      fileLog.info("file: wrote error output", { guidesDir });
    } finally {
      await onProgress({
        progress: Math.round(5 + per * idx),
        message: `Processed ${title}`,
        stage: "writing",
        currentFile: title,
        currentIndex: idx,
        totalFiles: relFiles.length,
      });
    }
  }

  await onProgress({
    progress: 90,
    message: "Creating zip...",
    stage: "zipping",
    currentIndex: relFiles.length,
    totalFiles: relFiles.length,
  });
  const manifestPath = path.join(outDir, "manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ runId: run.runId, uploadId: run.uploadId, guides: manifest }, null, 2),
    "utf8"
  );
  const zipPath = path.join(outDir, "guides.zip");
  log.info("runPipeline: preparing zip from outputs", {
    outputs: manifest.map((m) => m.outputFile),
    outputsCount: manifest.length,
  });
  // Zip ONLY the converted HTML files, with no folders and no manifest.
  await zipDirectoryToFile(guidesDir, zipPath);
  log.info("runPipeline: zip created", {
    zipPath,
    guidesDir,
    manifestPath,
    filesZipped: manifest.length,
  });
  await onProgress({ progress: 100, message: "Done" });

  return { zipPath };
}

