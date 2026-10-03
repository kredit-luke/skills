#!/bin/sh
# Start one person's hosted dashboard: put the workspace on the volume (the first time)
# or update it, then run the dashboard in the foreground. Two ways to get it there:
#
# From a published snapshot (no git, no code-host account; references/config.md "Snapshots"):
#   SNAPSHOT_CONFIG  repos.json's snapshot block as JSON, e.g. {"source":"azure-blob","account":"acme","container":"snapshots"}
#   plus the source's credentials (SNAPSHOT_AZURE_SAS, SNAPSHOT_S3_*, SNAPSHOT_HTTP_TOKEN...).
#   The repos come along too, as read-only copies.
#
# From git:
#   WORKSPACE_REPO  the workspace's git URL (https), cloned to $WORKSPACE_ROOT the first time
#   GIT_TOKEN       optional: a read token for it (GitHub, GitLab, Azure DevOps, Bitbucket...)
#   GIT_USERNAME    optional: the user name sent with GIT_TOKEN (default x-access-token)
#
# plus the DASHBOARD_* settings in references/hosting.md.
set -eu

mkdir -p "$CLAUDE_CONFIG_DIR"

if [ -n "${SNAPSHOT_CONFIG:-}" ]; then
  if ! node --disable-warning=ExperimentalWarning /opt/agentic-os/engine/bin/snapshot.mjs install --into "$WORKSPACE_ROOT" --repos; then
    # Start what's there only if it's a whole install, i.e. its stamp names a commit: one
    # that stopped while copying leaves "installing" (a mix of files). Exiting lets the
    # platform restart the container, which retries the install.
    if ! node -e 'try { process.exit(/^[0-9a-f]{7,64}$/.test(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sha) ? 0 : 1) } catch { process.exit(1) }' "$WORKSPACE_ROOT/.snapshot.json" \
       || [ ! -f "$WORKSPACE_ROOT/dashboard/bin/dashboard.mjs" ]; then
      echo "Couldn't install the workspace from its snapshot." >&2
      exit 1
    fi
    echo "Couldn't update the workspace from its snapshot; starting with what's there." >&2
  fi
else
  if [ -n "${GIT_TOKEN:-}" ]; then
    # Hand the token to git through askpass, so it's never written into a URL or config file.
    askpass=$(mktemp)
    printf '#!/bin/sh\ncase "$1" in Username*) echo "${GIT_USERNAME:-x-access-token}" ;; *) echo "$GIT_TOKEN" ;; esac\n' > "$askpass"
    chmod 700 "$askpass"
    export GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0
  fi

  if [ ! -d "$WORKSPACE_ROOT/.git" ]; then
    if [ -z "${WORKSPACE_REPO:-}" ]; then
      echo "Set SNAPSHOT_CONFIG (a published snapshot) or WORKSPACE_REPO (the workspace's git URL), or put a clone at $WORKSPACE_ROOT." >&2
      exit 1
    fi
    echo "Cloning the workspace into $WORKSPACE_ROOT..."
    git clone --quiet "$WORKSPACE_REPO" "$WORKSPACE_ROOT"
  else
    git -C "$WORKSPACE_ROOT" pull --ff-only --quiet || echo "Couldn't update the workspace; starting with what's there." >&2
  fi
fi

cd "$WORKSPACE_ROOT"
exec node dashboard/bin/dashboard.mjs run
