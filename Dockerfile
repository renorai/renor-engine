# Renor self-hosted engine. Node 22 is required (native modules).
#   docker run -p 3471:3471 -v renor-data:/data -e MVP_OWNER_EMAIL=... -e MVP_OWNER_PASSWORD=... <image>
# serves MCP over HTTP with OAuth sign-in for one owner; `docker run -i --rm -v renor-data:/data <image> mcp` is the
# stdio server. docs/self-hosting.md lists the settings.

# The base is pinned by version and digest, so a rebuild gets the same Node and the same Debian packages.
ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

FROM ${NODE_IMAGE} AS build
# Toolchain fallback for a dev dependency whose prebuilt binary is not available (the engine itself compiles nothing:
# SQLite is node:sqlite and sqlite-vec ships a prebuilt optional binary). Only this stage has it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Copy only what the build reads. A bare `COPY . .` would bake the builder's local files into the image:
# .env.local, credentials, keys, a local vault or SQLite state. The build needs tsconfig.json, src/ and the stamp script.
COPY tsconfig.json ./
COPY src ./src
COPY scripts/ci/stamp-build.mjs ./scripts/ci/stamp-build.mjs
# The build stamps a commit id. Without .git it needs one; this value only labels dist/BUILD.json (and /version).
ARG RENOR_BUILD_COMMIT=0000000
RUN RENOR_BUILD_COMMIT=${RENOR_BUILD_COMMIT} npm run build \
 && npm prune --omit=dev

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="renor-engine" \
      org.opencontainers.image.description="Renor: one shared, durable memory for your coding agents, over MCP" \
      org.opencontainers.image.source="https://github.com/renorai/renor-engine" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/renor-entrypoint

# No model, no key and no telemetry unless you configure them. Nothing secret is set here: the owner email and
# password come from the environment at run time.
ENV NODE_ENV=production \
    RENOR_DATA_DIR=/data \
    MVP_EMBEDDING_PROVIDER=none \
    EMBEDDING_PROVIDER=none \
    RENOR_TELEMETRY_DISABLED=true

# Memory, the OAuth client store and the stdio vault all live here. Mount a volume or they go with the container.
VOLUME ["/data"]
EXPOSE 3471

# /version answers only a loopback caller with no proxy hop, which is what a check from inside the container is.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MVP_PORT||process.env.PORT||3471)+'/version').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Starts as root only to hand the volume to the `node` user; the server itself runs as `node` (see the entrypoint).
ENTRYPOINT ["/usr/local/bin/renor-entrypoint"]
