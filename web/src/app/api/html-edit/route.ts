import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

export const runtime = "nodejs";

function getGeminiKey() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const source = process.env.GEMINI_API_KEY
    ? "GEMINI_API_KEY"
    : process.env.GOOGLE_API_KEY
      ? "GOOGLE_API_KEY"
      : null;
  return { key, source };
}

type GeminiModel = {
  name?: string;
  supportedGenerationMethods?: string[];
  displayName?: string;
};

async function listGeminiModels(apiKey: string, version: "v1" | "v1beta") {
  const url = new URL(`/${version}/models`, "https://generativelanguage.googleapis.com");
  url.searchParams.set("key", apiKey);
  const res = await fetch(url.toString(), { method: "GET" });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Gemini ListModels ${version} failed ${res.status}: ${text.slice(0, 300)}`);
  const json: unknown = JSON.parse(text);
  return (((json as { models?: GeminiModel[] })?.models || []) as GeminiModel[]).filter(Boolean);
}

function pickBestGeminiModel(models: GeminiModel[]) {
  const supports = (m: GeminiModel, method: string) =>
    (m.supportedGenerationMethods || []).includes(method);
  const name = (m: GeminiModel) => m.name || "";

  const eligible = models.filter((m) => supports(m, "generateContent"));
  const byPref = (prefs: RegExp[]) =>
    eligible.find((m) => prefs.every((re) => re.test(name(m)))) || null;

  return (
    byPref([/gemini/i, /2\.5/i, /flash/i, /lite/i]) ||
    byPref([/gemini/i, /2\.5/i, /flash/i]) ||
    byPref([/gemini/i, /flash/i, /lite/i]) ||
    byPref([/gemini/i, /2\./i, /flash/i]) ||
    byPref([/gemini/i, /1\./i, /flash/i]) ||
    eligible[0] ||
    null
  );
}

async function generateWithGemini(opts: { system: string; prompt: string }) {
  const { key: apiKey } = getGeminiKey();
  if (!apiKey) throw new Error("Gemini API key missing (set GEMINI_API_KEY or GOOGLE_API_KEY)");

  const configuredModel = process.env.GEMINI_MODEL || null;
  const configuredVersion =
    (process.env.GEMINI_API_VERSION as "v1" | "v1beta" | undefined) || null;

  let version: "v1" | "v1beta" = configuredVersion || "v1";
  let modelName = configuredModel;

  if (!modelName) {
    // Prefer v1; fall back to v1beta if v1 ListModels fails.
    try {
      const models = await listGeminiModels(apiKey, version);
      const best = pickBestGeminiModel(models);
      modelName = best?.name?.replace(/^models\//, "") || null;
    } catch {
      version = "v1beta";
      const models = await listGeminiModels(apiKey, version);
      const best = pickBestGeminiModel(models);
      modelName = best?.name?.replace(/^models\//, "") || null;
    }
  }

  if (!modelName) throw new Error("No Gemini model found that supports generateContent");

  const url = new URL(
    `/${version}/models/${encodeURIComponent(modelName)}:generateContent`,
    "https://generativelanguage.googleapis.com"
  );
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: `${opts.system}\n\n${opts.prompt}` }],
        },
      ],
      generationConfig: { temperature: 0.2 },
    }),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${text.slice(0, 300)}`);

  const json: unknown = JSON.parse(text);
  const candidates =
    (json as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })
      ?.candidates || [];
  const out = candidates
    .flatMap((c) => c.content?.parts || [])
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("\n")
    .trim();

  if (!out) throw new Error("Empty Gemini output");
  return out;
}

function normalizeHtmlFragment(input: string) {
  const trimmed = (input || "").trim();
  if (!trimmed) return "";

  // If a model returns a full document, try to extract the body contents.
  const bodyMatch = trimmed.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) return bodyMatch[1].trim();

  // Strip outer <html> wrapper if present.
  const htmlMatch = trimmed.match(/<html[^>]*>([\s\S]*?)<\/html>/i);
  if (htmlMatch?.[1]) return htmlMatch[1].trim();

  return trimmed;
}

function tryParseResponse(text: string): { html: string; summary: string } {
  const trimmed0 = (text || "").trim();
  if (!trimmed0) return { html: "", summary: "" };

  // Strip common markdown code-fence wrappers (```json ... ```), and also tolerate
  // providers that prefix with "json" on the first line.
  let trimmed = trimmed0
    .replace(/^```[a-zA-Z0-9_-]*\s*/m, "")
    .replace(/```[\s]*$/m, "")
    .trim();
  trimmed = trimmed.replace(/^\s*json\s*/i, "").trim();

  const maybeUnescape = (s: string) => {
    const nCount = (s.match(/\\n/g) || []).length;
    // If there are many \n sequences, it's likely the model double-escaped content.
    if (nCount >= 3) {
      return s.replaceAll("\\n", "\n").replaceAll("\\t", "\t");
    }
    return s;
  };

  const tryExtractFirstJsonObject = (input: string) => {
    const start = input.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < input.length; i++) {
      const ch = input[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth === 0) return input.slice(start, i + 1);
    }
    return null;
  };

  // Prefer JSON if the model follows instructions.
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed) as { html?: unknown; summary?: unknown };
      const html = typeof json.html === "string" ? maybeUnescape(json.html) : "";
      const summary = typeof json.summary === "string" ? json.summary : "";
      return { html, summary };
    } catch {
      // fall through
    }
  }

  // If the model wrapped extra text around the JSON, try to extract the first object.
  const extracted = tryExtractFirstJsonObject(trimmed);
  if (extracted) {
    try {
      const json = JSON.parse(extracted) as { html?: unknown; summary?: unknown };
      const html = typeof json.html === "string" ? maybeUnescape(json.html) : "";
      const summary = typeof json.summary === "string" ? json.summary : "";
      if (html || summary) return { html, summary };
    } catch {
      // ignore
    }
  }

  // Fallback: parse tagged sections.
  const htmlTag = trimmed.match(/<HTML>([\s\S]*?)<\/HTML>/i)?.[1]?.trim() || "";
  const summaryTag =
    trimmed.match(/<SUMMARY>([\s\S]*?)<\/SUMMARY>/i)?.[1]?.trim() || "";
  if (htmlTag) return { html: htmlTag, summary: summaryTag };

  // Last resort: treat the whole response as the HTML fragment.
  return { html: trimmed, summary: "" };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as
      | {
          title?: unknown;
          html?: unknown;
          instruction?: unknown;
          provider?: unknown;
        }
      | null;

    const title = typeof body?.title === "string" ? body.title : "";
    const html = typeof body?.html === "string" ? body.html : "";
    const instruction =
      typeof body?.instruction === "string" ? body.instruction : "";
    const providerRaw = typeof body?.provider === "string" ? body.provider : "auto";
    const provider =
      providerRaw === "openai" || providerRaw === "gemini" || providerRaw === "auto"
        ? (providerRaw as "openai" | "gemini" | "auto")
        : "auto";

    if (!html.trim()) {
      return Response.json({ error: "Missing html" }, { status: 400 });
    }
    if (!instruction.trim()) {
      return Response.json({ error: "Missing instruction" }, { status: 400 });
    }

    const system =
      "You edit existing HTML guides for non-technical users. " +
      "You will be given an HTML fragment (no <html>, no <head>, no <body>). " +
      "Apply the user's instruction while preserving unrelated content and structure. " +
      "Return STRICT JSON: {\"summary\": string, \"html\": string}. " +
      "The html field must be ONLY an HTML fragment (no <html>, no <head>, no <body>). " +
      "No markdown. No code fences. Do not wrap the JSON in ```.";

    const prompt =
      (title ? `Title: ${title}\n\n` : "") +
      `Instruction:\n${instruction}\n\n` +
      "Current HTML fragment:\n" +
      html +
      "\n\n" +
      'Return only JSON. Example: {"summary":"...","html":"<article>...</article>"}';

    const hasOpenAi = !!process.env.OPENAI_API_KEY;
    const hasGemini = !!getGeminiKey().key;

    const callOpenAi = async () => {
      if (!hasOpenAi) throw new Error("OPENAI_API_KEY missing");
      const result = await generateText({
        model: openai("gpt-5.1-mini"),
        system,
        prompt,
        temperature: 0.2,
      });
      return result.text || "";
    };

    const callGemini = async () => {
      if (!hasGemini) throw new Error("Gemini key missing");
      return await generateWithGemini({ system, prompt });
    };

    const primary: "openai" | "gemini" =
      provider === "auto" ? (hasOpenAi ? "openai" : "gemini") : provider;
    const fallback: "openai" | "gemini" = primary === "openai" ? "gemini" : "openai";

    let providerUsed: "openai" | "gemini" = primary;
    let rawText = "";
    try {
      rawText = primary === "openai" ? await callOpenAi() : await callGemini();
    } catch (e) {
      // If the caller explicitly chose a provider, do not fall back.
      if (provider !== "auto") throw e;
      if ((fallback === "openai" && !hasOpenAi) || (fallback === "gemini" && !hasGemini)) {
        throw e;
      }
      providerUsed = fallback;
      rawText = fallback === "openai" ? await callOpenAi() : await callGemini();
    }

    const parsed = tryParseResponse(rawText || "");
    const nextHtml = normalizeHtmlFragment(parsed.html || "");
    const summary = (parsed.summary || "").trim();

    if (!nextHtml) {
      return Response.json(
        { error: "Model returned empty HTML" },
        { status: 500 }
      );
    }

    return Response.json({
      html: nextHtml,
      summary: summary || "Applied changes",
      provider: providerUsed,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to edit HTML" },
      { status: 500 }
    );
  }
}

