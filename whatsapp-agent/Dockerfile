FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# python3/make/g++: fallback only. better-sqlite3 ships prebuilt binaries for Node's active
# LTS lines (pinned to a 12.x version in package.json specifically because 13.x requires
# Node >=22, which this image doesn't have — that mismatch is what forced a from-source
# node-gyp build the one time this actually broke a deploy). `npm ci` here installs the full
# dependency tree including better-sqlite3, so the builder stage needs this too, not just
# runtime, even though the builder's own output (compiled JS) doesn't use it directly.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev

# Chromium + OS deps for the optional WatchFacts scraper (src/watchfacts/scraper.ts).
# Only exercised when WATCHFACTS_ENABLED=true, but installed unconditionally so toggling
# that env var doesn't require a rebuild.
RUN npx playwright install --with-deps chromium

COPY --from=builder /app/dist ./dist
COPY data ./data

# /app/persist holds everything that needs to survive a restart/redeploy (conversation
# state, blast status, uploaded contacts/inventory CSVs, uploaded banner image) — mount one
# Railway volume here. Created here too so the app has somewhere to write before a volume
# is attached (e.g. first local `docker run`).
RUN mkdir -p /app/persist/storage /app/persist/data /app/persist/assets

EXPOSE 3000
CMD ["node", "dist/index.js"]
