## Web App

This is a [Next.js](https://nextjs.org) starter for the frontend portion of the take-home.

### Getting Started

We use **Bun** as the package manager. If you don't have it installed:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then install dependencies and run the dev server:

```bash
bun install
bun dev
```

Open [http://localhost:3000](http://localhost:3000) to see your app.

### Structure

- `src/app/` — App Router pages and layouts
- `src/app/globals.css` — Global styles (Tailwind configured)
- `public/` — Static assets

### Pre-configured Tools

[**Vercel AI SDK**](https://ai-sdk.dev/docs/introduction) — Use this for all AI/LLM interactions. Please use v5. [Docs](https://ai-sdk.dev/docs/introduction) We already setup your chat route, and you have been provided an OpenAI API key to use.

[**shadcn/ui**](https://ui.shadcn.com) — Add components as needed:

```bash
bunx shadcn add <component>
```

### What to Build

Refer to the root `README.md` for the full prompt. For the web app portion, focus on letting users start runs, see progress, and get results—without exposing infrastructure complexity.
