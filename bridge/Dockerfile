# syntax=docker/dockerfile:1
#
# roon-inkplate-bridge: Roon extension that serves Inkplate 6PLUS frames on :8765.
# Build:  docker compose build      Run: docker compose up -d
# Multi-arch: builds natively on Apple silicon (arm64) and x86_64 hosts.

# The base image is pinned by tag; Dependabot (.github/dependabot.yml) proposes updates.
# For fully reproducible builds, pin by digest instead, in both FROM lines:
#   docker buildx imagetools inspect node:24-trixie-slim   -> node:24-trixie-slim@sha256:...

# ---- dependencies --------------------------------------------------------------
FROM node:24-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# The Roon API packages come from GitHub; npm fetches them as tarballs, no git needed.
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime -----------------------------------------------------------------------
FROM node:24-trixie-slim

# sharp renders the track text through fontconfig, so the image needs real fonts
# (-extra adds the true italic used for the album line).
RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core fonts-dejavu-extra \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Force world-readable: COPY keeps the host's mode bits, and files saved on a Mac
# can be owner-only (600), which the non-root node user then can't read.
COPY --chmod=644 package.json bridge.js ./

# node-roon-api keeps the pairing token in config.json in the working directory,
# so run from a volume to stay paired across rebuilds.
RUN mkdir /data && chown node:node /data
VOLUME /data
WORKDIR /data
USER node

ENV NODE_ENV=production \
    PORT=8765 \
    FONT="DejaVu Sans"

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "/app/bridge.js"]
