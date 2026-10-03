# One person's hosted dashboard (references/hosting.md). Build it once per workspace and
# run one container per person, each with its own volume at /data. Build from
# plugins/natterjack, so the engine's snapshot install (the boot without git) comes along:
#
#   docker build -f plugins/natterjack/templates/hosted/Dockerfile -t <registry>/natterjack-dashboard:1 plugins/natterjack
#
# Cloud-neutral: any container platform with a persistent volume works (Kubernetes on
# GKE/EKS/AKS, a VM with Docker, ...). Nothing here holds a secret; they come from the
# environment at run time.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl tini procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data

# The Claude CLI, installed for the image's own user. Update it by rebuilding the image
# (auto-update is off so every person runs the version you tested).
USER node
RUN curl -fsSL https://claude.ai/install.sh | bash

# Optional: require Claude logins to belong to your organization. Put
#   { "forceLoginMethod": "claudeai", "forceLoginOrgUUID": ["<your org id>"] }
# (org id: `claude auth status` on a signed-in machine) in managed-settings.json next to
# this file and uncomment:
# USER root
# COPY templates/hosted/managed-settings.json /etc/claude-code/managed-settings.json
# USER node

# The engine's server code (Node only, no packages), for `snapshot.mjs install`: the
# boot from a published snapshot, before there's a workspace on the volume to run it from.
COPY engine/package.json /opt/natterjack/engine/package.json
COPY engine/bin/snapshot.mjs /opt/natterjack/engine/bin/snapshot.mjs
COPY engine/shared /opt/natterjack/engine/shared
COPY engine/server/src /opt/natterjack/engine/server/src
COPY --chown=node templates/hosted/entrypoint.sh /usr/local/bin/dashboard-entrypoint

# Everything personal lives on the volume: the workspace (its .claude/ledger holds runs
# and tracker keys) and Claude's config (sign-in, transcripts, memory).
ENV DASHBOARD_HOSTED=1 \
    WORKSPACE_ROOT=/data/workspace \
    CLAUDE_CONFIG_DIR=/data/claude \
    DASHBOARD_CLAUDE_BIN=/home/node/.local/bin/claude \
    DISABLE_AUTOUPDATER=1 \
    DASHBOARD_PORT=3333
VOLUME /data
EXPOSE 3333

ENTRYPOINT ["tini", "--", "sh", "/usr/local/bin/dashboard-entrypoint"]
