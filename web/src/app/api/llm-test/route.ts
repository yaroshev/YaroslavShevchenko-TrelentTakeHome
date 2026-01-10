export const runtime = "nodejs";

function getGeminiKey() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const source = process.env.GEMINI_API_KEY ? "GEMINI_API_KEY" : process.env.GOOGLE_API_KEY ? "GOOGLE_API_KEY" : null;
  return { key, source };
}

type GeminiModel = {
  name?: string;
  supportedGenerationMethods?: string[];
  displayName?: string;
};

async function listModels(apiKey: string, version: "v1" | "v1beta") {
  const url = new URL(`/${version}/models`, "https://generativelanguage.googleapis.com");
  url.searchParams.set("key", apiKey);
  const res = await fetch(url.toString(), { method: "GET" });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`ListModels ${version} failed ${res.status}: ${text.slice(0, 300)}`);

  const json: unknown = JSON.parse(text);
  const models = ((json as { models?: GeminiModel[] })?.models || []).filter(Boolean);
  return { models, raw: json };
}

function pickBestModel(models: GeminiModel[]) {
  const supports = (m: GeminiModel, method: string) => (m.supportedGenerationMethods || []).includes(method);
  const name = (m: GeminiModel) => m.name || "";

  const eligible = models.filter((m) => supports(m, "generateContent"));
  const byPref = (prefs: RegExp[]) =>
    eligible.find((m) => prefs.every((re) => re.test(name(m)))) || null;

  return (
    // Prefer Flash-Lite variants first (usually free-tier friendly)
    byPref([/gemini/i, /flash/i, /lite/i]) ||
    // Then prefer newer flash models
    byPref([/gemini/i, /2\./i, /flash/i]) ||
    byPref([/gemini/i, /1\./i, /flash/i]) ||
    eligible[0] ||
    null
  );
}

async function testGemini(overrides?: { model?: string | null; version?: "v1" | "v1beta" | null }) {
  const { key: apiKey, source } = getGeminiKey();
  if (!apiKey) {
    return {
      ok: false as const,
      error: "Gemini key is missing",
      debug: {
        cwd: process.cwd(),
        hasGEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
        hasGOOGLE_API_KEY: !!process.env.GOOGLE_API_KEY,
      },
    };
  }

  const configuredModel = process.env.GEMINI_MODEL || null;
  const configuredVersion = (process.env.GEMINI_API_VERSION as "v1" | "v1beta" | undefined) || null;

  let version: "v1" | "v1beta" = configuredVersion || "v1";
  let modelName = configuredModel;
  let modelSource: "env" | "autodetect" | "query" = configuredModel ? "env" : "autodetect";
  const modelsChecked: { version: "v1" | "v1beta"; count: number }[] = [];

  if (overrides?.version) version = overrides.version;
  if (overrides?.model) {
    modelName = overrides.model;
    modelSource = "query";
  }

  if (!modelName) {
    // Prefer v1; fall back to v1beta if v1 ListModels fails.
    try {
      const { models } = await listModels(apiKey, version);
      modelsChecked.push({ version, count: models.length });
      const best = pickBestModel(models);
      modelName = best?.name?.replace(/^models\//, "") || null;
    } catch {
      version = "v1beta";
      const { models } = await listModels(apiKey, version);
      modelsChecked.push({ version, count: models.length });
      const best = pickBestModel(models);
      modelName = best?.name?.replace(/^models\//, "") || null;
    }
  }

  if (!modelName) {
    return {
      ok: false as const,
      error: "No Gemini model found that supports generateContent",
      debug: {
        keySource: source,
        keyLength: apiKey.length,
        version,
        configuredModel,
        configuredVersion,
        overrideModel: overrides?.model || null,
        overrideVersion: overrides?.version || null,
        modelsChecked,
      },
    };
  }

  const url = new URL(`/${version}/models/${encodeURIComponent(modelName)}:generateContent`, "https://generativelanguage.googleapis.com");
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: "Reply with the single word: OK" }],
        },
      ],
      generationConfig: { temperature: 0 },
    }),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return {
      ok: false as const,
      error: `Gemini error ${res.status}: ${text.slice(0, 300)}`,
      debug: {
        keySource: source,
        keyLength: apiKey.length,
        version,
        model: modelName,
        modelSource,
        configuredModel,
        configuredVersion,
        overrideModel: overrides?.model || null,
        overrideVersion: overrides?.version || null,
        modelsChecked,
      },
    };
  }

  return {
    ok: true as const,
    model: modelName,
    debug: {
      keySource: source,
      keyLength: apiKey.length,
      version,
      modelSource,
      configuredModel,
      configuredVersion,
      overrideModel: overrides?.model || null,
      overrideVersion: overrides?.version || null,
      modelsChecked,
    },
    raw: text.slice(0, 3000),
  };
}

export async function GET(req: Request) {
  const { key: apiKey, source } = getGeminiKey();
  const u = new URL(req.url);
  const listRequested = u.searchParams.get("list") === "1" || process.env.GEMINI_LLM_TEST_LIST === "1";

  // Optional single-request override to test a specific model/version.
  const overrideModel = u.searchParams.get("model");
  const overrideVersionRaw = u.searchParams.get("version");
  const overrideVersion =
    overrideVersionRaw === "v1" || overrideVersionRaw === "v1beta" ? overrideVersionRaw : null;

  if (listRequested && apiKey) {
    const configuredVersion = (process.env.GEMINI_API_VERSION as "v1" | "v1beta" | undefined) || null;
    const preferred: Array<"v1" | "v1beta"> = configuredVersion ? [configuredVersion] : ["v1", "v1beta"];
    const results: Array<{ version: "v1" | "v1beta"; models: Array<{ name: string; methods: string[] }> }> = [];
    for (const v of preferred) {
      try {
        const { models } = await listModels(apiKey, v);
        const simplified = models
          .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
          .slice(0, 200)
          .map((m) => ({
            name: (m.name || "").replace(/^models\//, ""),
            methods: m.supportedGenerationMethods || [],
          }));
        results.push({ version: v, models: simplified });
      } catch {
        // ignore version failures
      }
    }
    return Response.json({
      ok: true,
      mode: "list",
      debug: { keySource: source, keyLength: apiKey.length, configuredVersion },
      results,
      note:
        "This list reflects what YOUR API key can access. Prefer a flash-lite model if available (e.g. gemini-2.0-flash-lite / gemini-2.5-flash-lite).",
    });
  }

  const gemini = await testGemini({ model: overrideModel, version: overrideVersion });
  if (!gemini.ok) {
    return Response.json(
      {
        ok: false,
        gemini,
        note:
          "Gemini API key mode does not require a project id. If you are using Vertex AI, this endpoint is not the right integration.",
      },
      { status: 500 }
    );
  }

  return Response.json({
    ok: true,
    gemini,
    note:
      "Gemini API key mode does not require a project id. If you need Vertex AI instead, we can switch to that integration.",
  });
}

