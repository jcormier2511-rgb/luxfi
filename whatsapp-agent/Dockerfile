FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
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
