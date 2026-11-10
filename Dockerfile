# Self-hosted Prismix: the SPA (built with VITE_BACKEND=server) plus the Node
# server in server/, which stores images and settings under /data.
#
#   docker build -t prismix .
#   docker run -p 127.0.0.1:8787:8787 -v prismix-data:/data prismix

ARG NODE_VERSION=24
ARG PNPM_VERSION=11.3.0

# --- Build: install everything, build the client and bundle the server ---------
FROM node:${NODE_VERSION}-slim AS build
ARG PNPM_VERSION
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN VITE_BACKEND=server pnpm build && pnpm build:server

# --- Runtime deps: only the bundle's externals (see server/build.mjs) -----------
FROM node:${NODE_VERSION}-slim AS runtime-deps
WORKDIR /deps
COPY --from=build /src/build/hosted/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# --- Runtime --------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim
# Fonts for server-rendered text (the debug provider's placeholder images).
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8787 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/build/client

WORKDIR /app
COPY --from=build /src/build/client ./build/client
COPY --from=build /src/build/hosted ./build/hosted
COPY --from=runtime-deps /deps/node_modules ./build/hosted/node_modules

# The base image's unprivileged `node` user owns the data directory.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 8787}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--enable-source-maps", "build/hosted/index.mjs"]
