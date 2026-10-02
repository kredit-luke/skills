# One person's hosted dashboard (references/hosting.md). Build it once per workspace and
# run one container per person, each with its own volume at /data:
#
#   docker build -t <registry>/agentic-dashboard:1 plugins/agentic-os/templates/hosted
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
# COPY managed-settings.json /etc/claude-code/managed-settings.json
# USER node

COPY --chown=node entrypoint.sh /usr/local/bin/dashboard-entrypoint

# Everything personal lives on the volume: the workspace clone (its .claude/ledger holds
# runs and tracker keys) and Claude's config (sign-in, transcripts, memory).
ENV DASHBOARD_HOSTED=1 \
    WORKSPACE_ROOT=/data/workspace \
    CLAUDE_CONFIG_DIR=/data/claude \
    DASHBOARD_CLAUDE_BIN=/home/node/.local/bin/claude \
    DISABLE_AUTOUPDATER=1 \
    DASHBOARD_PORT=3333
VOLUME /data
EXPOSE 3333

ENTRYPOINT ["tini", "--", "sh", "/usr/local/bin/dashboard-entrypoint"]
