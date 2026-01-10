FROM oven/bun:1.1.45

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000

# Dev server for easy evaluation. For production, switch to `bun run build` + `bun run start`.
CMD ["bun", "run", "dev", "--", "-p", "3000", "-H", "0.0.0.0"]

