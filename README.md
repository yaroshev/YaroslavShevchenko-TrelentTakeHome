# Trelent Take Home Prototype

This repo contains a small, deployment-ready prototype that lets a non-technical user:

- Upload files or an entire folder
- Convert them into clean HTML guides
- Download a zip of results

The UI is a 3-step wizard. The backend runs work in the background and exposes simple status polling and a zip download.

## Quick start (local)

1) Add env vars:

- Edit `web/.env.local` and fill:
  - `OPENAI_API_KEY`
  - `GEMINI_API_KEY` (fallback if OpenAI fails)
  - `DATA_INGESTION_API_URL`
  - `DATA_INGESTION_API_TOKEN`

2) Run the web app:

```bash
cd web
bun install
bun dev
```

Open `http://localhost:3000`.

## Quick start (Docker)

1) Fill `web/.env.local` (same keys as above)

2) Run:

```bash
docker compose up --build
```

Open `http://localhost:3000`.

## What I built

- **Frontend**: Next.js app in `web/` with a step-by-step wizard:
  - Step 1: Drag and drop or pick files/folders, upload with progress
  - Step 2: Convert, show progress and “this may take a moment”
  - Step 3: Download the resulting zip
- **Backend**: Next.js API routes that persist uploads and runs on disk:
  - `POST /api/upload`: accepts multipart form data, stores files under `web/.data/uploads/<uploadId>`
  - `POST /api/runs`: creates a run and starts a background worker loop
  - `GET /api/runs/:runId`: status polling
  - `GET /api/runs/:runId/download`: streams the output zip

## How the pieces fit

- The browser uploads files to the server.
- The server creates a run, then a background worker processes queued runs.
- The pipeline converts each file to markdown (uses ingestion API when configured, falls back to local parsing for common formats), rewrites into HTML (uses OpenAI if configured), then zips output for download.
- If OpenAI fails, it falls back to Gemini when `GEMINI_API_KEY` is set.

## Tradeoffs

- The worker is a single-process loop and run state is stored on disk for simplicity.
- For real scale: replace disk with object storage and move the worker to a separate service with a queue.

## What I would do next

- Use the official ingestion API SDK and exact endpoints from the docs
- Make conversion idempotent and add retries with backoff per file
- Add run history and a simple results preview UI