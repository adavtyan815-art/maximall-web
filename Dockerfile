# ─── Stage 1: Build ───────────────────────────────────────────────────────────
# Node 22: puppeteer-core 25 requires >= 22.12 (dossier PDF), cheerio >= 20.18
FROM node:22-alpine AS builder

WORKDIR /app

# Install build tools required by bcrypt (node-gyp needs python3 + make + g++)
RUN apk add --no-cache python3 make g++

# Copy package files first (layer cache optimization)
COPY package*.json ./

# Install ALL dependencies (including devDeps needed for tsc)
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript → dist/
# The AI layer (+ @anthropic-ai/sdk types) makes tsc exceed Node's default heap on the 1 GiB t3.micro host
# (2026-10-06: "JavaScript heap out of memory"); the host has 2 GiB swap.
RUN NODE_OPTIONS=--max-old-space-size=1536 npm run build

# ─── Stage 2: Production image ────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Install build tools required by bcrypt (node-gyp needs python3 + make + g++)
RUN apk add --no-cache python3 make g++

# Copy package files and install PRODUCTION deps only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Remove build tools after compilation to keep the image lean
RUN apk del python3 make g++

# AI dossier PDF: headless Chromium + fonts with Cyrillic (the dossier is Russian). Found at /usr/bin/chromium-browser;
# runs with --no-sandbox automatically because the container runs as root.
RUN apk add --no-cache chromium nss freetype harfbuzz font-dejavu font-noto

# Copy compiled JS from builder stage
COPY --from=builder /app/dist ./dist

# Copy static public files
COPY public/ ./public/

# AI consultant: the catalog index (prices, mappings) the backend loads from /app/data/catalog/index.json.
# Runtime data (logs, renders, dossiers, leads, AR, clips, spend ledger) lives under /app/data -> a volume (docker-compose).
COPY data/catalog/ ./data/catalog/
# QA-059: incoming /ai payloads are validated against the JSON contracts at runtime (/app/contracts)
COPY contracts/ ./contracts/

# Expose the application port (default 3000, can be overridden via PORT env var)
EXPOSE 3000

# Health-check so Docker / orchestrators know when the app is ready
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/api/settings || exit 1

# Start the compiled server
CMD ["node", "dist/server.js"]
