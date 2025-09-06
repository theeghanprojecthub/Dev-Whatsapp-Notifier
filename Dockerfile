FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-noto-color-emoji dumb-init curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# copy manifests only
COPY package.json package-lock.json* ./

# If lockfile exists, use `npm ci`; otherwise fall back to `npm install`
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# now copy the rest
COPY . .

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/healthz || exit 1

USER node
CMD ["dumb-init","node","server.js"]
