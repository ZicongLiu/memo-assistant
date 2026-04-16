# ── Stage 1: Install dependencies (native build for better-sqlite3) ───────────
FROM node:20-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci

# ── Stage 2: Build Next.js app ────────────────────────────────────────────────
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_PUBLIC_APP_ENABLED=true
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:20-alpine AS runner
RUN apk add --no-cache python3 make g++
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy built output and runtime deps
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/src ./src

# Data directory — mounted as a Fly.io volume in production
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
