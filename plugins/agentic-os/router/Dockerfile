# The agentic-os router (references/hosting.md, "One address for everyone"). Build from
# plugins/agentic-os so the engine's hosted.ts (the shared request checks) comes along:
#
#   docker build -f plugins/agentic-os/router/Dockerfile -t <registry>/agentic-router:1 plugins/agentic-os
FROM node:24-bookworm-slim
WORKDIR /app
COPY engine/server/src/hosted.ts engine/server/src/hosted.ts
COPY router/package.json router/package.json
COPY router/src router/src
USER node
ENV ROUTER_PORT=8080
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "router/src/main.ts"]
