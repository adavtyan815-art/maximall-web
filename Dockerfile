# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

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
RUN npm run build

# ─── Stage 2: Production image ────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Install build tools required by bcrypt (node-gyp needs python3 + make + g++)
RUN apk add --no-cache python3 make g++

# Copy package files and install PRODUCTION deps only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Remove build tools after compilation to keep the image lean
RUN apk del python3 make g++

# Copy compiled JS from builder stage
COPY --from=builder /app/dist ./dist

# Copy static public files
COPY public/ ./public/

# Expose the application port (default 3000, can be overridden via PORT env var)
EXPOSE 3000

# Health-check so Docker / orchestrators know when the app is ready
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/api/settings || exit 1

# Start the compiled server
CMD ["node", "dist/server.js"]
