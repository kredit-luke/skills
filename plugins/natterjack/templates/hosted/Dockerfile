# One person's hosted dashboard (references/hosting.md). Build it once per workspace and
# run one container per person, each with its own volume at /data. Build from
# plugins/natterjack, so the engine's snapshot install (the boot without git) comes along:
#
#   docker build -f plugins/natterjack/templates/hosted/Dockerfile --pull --no-cache -t <registry>/natterjack-dashboard:<tag> plugins/natterjack
#
# Cloud-neutral: any container platform with a persistent volume works (Kubernetes on
# GKE/EKS/AKS, a VM with Docker, ...). Nothing here holds a secret; they come from the
# environment at run time.
FROM node:24-bookworm-slim

# Upgrade first: the base image lags Debian security releases, so without it a rebuild
# keeps the packages the base shipped with.
#
# The GitHub CLI comes from GitHub's own apt repository (Debian's lags well behind): people
# sign in to it from the Machine page, so their runs push and open pull requests as them.
# openssh-client is for ssh-keygen: git signs their commits with an SSH key (github-login.ts).
RUN apt-get update \
 && apt-get dist-upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl tini procps \
 && install -d -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
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
# and tracker keys), Claude's config (sign-in, transcripts, memory), the GitHub CLI's
# sign-in, and git's global config (its credential helper, and the commit name and email).
ENV DASHBOARD_HOSTED=1 \
    WORKSPACE_ROOT=/data/workspace \
    CLAUDE_CONFIG_DIR=/data/claude \
    GH_CONFIG_DIR=/data/gh \
    GIT_CONFIG_GLOBAL=/data/gitconfig \
    DASHBOARD_CLAUDE_BIN=/home/node/.local/bin/claude \
    DISABLE_AUTOUPDATER=1 \
    DASHBOARD_PORT=3333
VOLUME /data
EXPOSE 3333

ENTRYPOINT ["tini", "--", "sh", "/usr/local/bin/dashboard-entrypoint"]
