# The natterjack router (references/hosting.md, "One address for everyone"). Build from
# plugins/natterjack so the engine's hosted.ts (the shared request checks) and
# link-tokens.ts (Remote control's routing) come along:
#
#   docker build -f plugins/natterjack/router/Dockerfile --pull --no-cache -t <registry>/natterjack-router:<tag> plugins/natterjack
FROM node:24-trixie-slim
# The base image lags Debian security releases, so without this a rebuild keeps the
# packages the base shipped with.
#
# The router is plain Node with no packages, so it also drops the npm (and corepack) the
# base image bundles: scanners report npm's own dependencies (undici, brace-expansion),
# and the base image lags their fixes too.
RUN apt-get update \
 && apt-get dist-upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY engine/server/src/hosted.ts engine/server/src/hosted.ts
COPY engine/server/src/link-tokens.ts engine/server/src/link-tokens.ts
COPY router/package.json router/package.json
COPY router/src router/src
USER node
ENV ROUTER_PORT=8080
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "router/src/main.ts"]
