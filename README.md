## Trelent FDE Take-Home — Document → HTML Guide Converter

This repo is a small end-to-end prototype that lets a non-technical user upload a messy folder of internal docs (PDFs, Word docs, etc.) and download a **zip of cleaned HTML “guides”**. It runs as a **repeatable background pipeline** (not one big blocking request), records run status/progress, and includes multiple fallbacks so the demo still works even if external APIs fail.

### What I built

- **Next.js UI (`/web`)**
  - A simple 3-step flow: **Upload → Convert → Download**.
  - Progress bar + “currently processing file X/Y”.
  - A user-friendly failure state (“Something went wrong…”) with a **Contact Support** button.
  - A **reviewer/debug** section on Step 3 that exposes a run-scoped server log (scrubbed) and a button to open the failure UI on-demand for fast evaluation. In a real product, this reviewer-only surface area would not be shown to end users.

- **Backend workflow (inside the Next.js app)**
  - A queued **run** model stored on disk, processed by a background worker loop (non-serverless).
  - For each uploaded file:
    1) convert to Markdown (prefer Trelent ingestion API; fallback to local extraction)
    2) rewrite into consistent HTML (OpenAI primary, Gemini fallback, local Markdown→HTML fallback)
    3) write one HTML file per input and zip the results

### How to run

#### Option A: Docker (recommended)

1) Create `web/.env.local` (Docker Compose loads it automatically).

2) Start:

```bash
docker compose up --build
```

3) Open `http://localhost:3000`

#### Option B: Local dev (Bun)

```bash
cd web
bun install
bun dev
```

Then open `http://localhost:3000`.

### Configuration (env vars)

Create `web/.env.local`:

```bash
# LLM (primary)
OPENAI_API_KEY=...

# Trelent Data Ingestion API (optional but preferred when available)
DATA_INGESTION_API_URL=https://api.trelent.com
DATA_INGESTION_API_TOKEN=...

# If the ingestion convert endpoint path differs, override candidates (comma-separated absolute URLs)
# DATA_INGESTION_CONVERT_URLS="https://api.trelent.com/<correct-path>,https://api.trelent.com/<alt-path>"

# Gemini fallback (optional)
GEMINI_API_KEY=...
# Optional tuning:
# GEMINI_MODEL=gemini-2.5-flash-lite
# GEMINI_API_VERSION=v1
# GEMINI_MIN_DELAY_MS=1200

# Debug/ops toggles (optional)
# DEBUG_EXPOSE_PROVIDER_ERRORS=1
# RUN_LOGS_TO_FILE=0
# DATA_DIR=/absolute/path/to/store/.data
```

Notes:
- If **neither OpenAI nor Gemini** is configured, the pipeline still completes using a local Markdown→HTML fallback (less “polished,” but runnable).
- If the **Trelent ingestion API** isn’t configured (or fails), the pipeline falls back to local extraction using `pdf-parse` (PDF), `mammoth` (DOCX), and best-effort text decode.

### How the pieces fit together

- **Upload**
  - UI posts to `POST /api/upload`
  - Server saves files under:
    - `.data/uploads/<uploadId>/input/**`

- **Run / background processing**
  - UI starts a run via `POST /api/runs` → returns `runId`
  - Run state is stored at:
    - `.data/runs/<runId>/state.json`
  - In **non-serverless** environments, a background worker loop continuously looks for queued runs and processes them.
  - In **serverless** environments, `POST /api/runs` streams progress as NDJSON while processing inline (so the UI still gets real progress updates).

- **Download**
  - Results are written to:
    - `.data/uploads/<uploadId>/output/<runId>/guides/*.html`
    - `.data/uploads/<uploadId>/output/<runId>/guides.zip`
  - UI downloads via `GET /api/runs/<runId>/download`

- **Run-scoped logs**
  - A structured JSONL log is persisted per run:
    - `.data/runs/<runId>/server.log`
  - UI can fetch it from `GET /api/runs/<runId>/log` (used in the “For reviewers” section).

### Key tradeoffs / decisions

- **File-system storage instead of DB/queue**
  - Fast to implement and easy to run locally, but not ideal for concurrency, durability, or multi-instance deployments.

- **Single-process worker**
  - The worker loop is intentionally simple. Scaling would mean moving to a real queue + dedicated worker(s) and adding concurrency controls.

- **Provider fallbacks to keep runs “always runnable”**
  - I ran into issues getting the company-provided ingestion API working reliably, so the pipeline has a structured fallback ladder:
    - Trelent ingestion API → local extraction
    - OpenAI rewrite → Gemini rewrite → local Markdown→HTML
  - Gemini free-tier was finicky (model availability + rate limits), so the code serializes Gemini calls and spaces them out to reduce 429s.

- **Error experience**
  - If a single file fails for a “normal” reason, the pipeline **writes an error HTML** for that file and continues, so the user still gets a zip.
  - If all LLM providers are exhausted (the “support message” case), the pipeline treats it as a **critical failure** and fails the entire run (so we don’t silently generate low-quality or misleading output).
  - The UI includes a non-technical error lightbox and a “Contact Support” mailto. Longer-term, it’d be great to attach a sanitized log snippet automatically.

- **Logging is intentionally verbose**
  - It helped during API debugging, but it should be trimmed and structured for readability before production.

### What I’d do next with more time

- **UI polish + branding**
  - Make it feel like a real product (better copy, clearer affordances, “guide preview” before download, onboarding hints).

- **Performance improvement (easy win)**
  - Right now the ingestion logic “tries endpoints” per document. A straightforward improvement would be:
    - detect a working ingestion endpoint once, cache it, then reuse it for the remaining files (and only re-probe if it starts failing).

- **Make it production-grade**
  - Replace disk state with a durable store (Postgres) + queue (SQS/Redis) + worker pool.
  - Add idempotency keys, retries with backoff, and better cancellation/resume semantics.
  - Add observability: structured logs, metrics, tracing, and a first-class “support bundle” export.

- **Actually build the “guide assembly” story**
  - This prototype converts *one input → one output*. A real version would support:
    - combining multiple docs into one guide
    - reusing sections across guides
    - basic search/indexing over ingested content to power “guide builder” UX

