#!/bin/sh
# Start one person's hosted dashboard: clone the workspace onto the volume the first
# time (pull it afterwards), then run the dashboard in the foreground.
#
#   WORKSPACE_REPO  the workspace's git URL (https), cloned to $WORKSPACE_ROOT the first time
#   GIT_TOKEN       optional: a read token for it (GitHub, GitLab, Azure DevOps, Bitbucket...)
#   GIT_USERNAME    optional: the user name sent with GIT_TOKEN (default x-access-token)
# plus the DASHBOARD_* settings in references/hosting.md.
set -eu

mkdir -p "$CLAUDE_CONFIG_DIR"

if [ -n "${GIT_TOKEN:-}" ]; then
  # Hand the token to git through askpass, so it's never written into a URL or config file.
  askpass=$(mktemp)
  printf '#!/bin/sh\ncase "$1" in Username*) echo "${GIT_USERNAME:-x-access-token}" ;; *) echo "$GIT_TOKEN" ;; esac\n' > "$askpass"
  chmod 700 "$askpass"
  export GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0
fi

if [ ! -d "$WORKSPACE_ROOT/.git" ]; then
  if [ -z "${WORKSPACE_REPO:-}" ]; then
    echo "Set WORKSPACE_REPO to the workspace's git URL (or put a clone at $WORKSPACE_ROOT)." >&2
    exit 1
  fi
  echo "Cloning the workspace into $WORKSPACE_ROOT..."
  git clone --quiet "$WORKSPACE_REPO" "$WORKSPACE_ROOT"
else
  git -C "$WORKSPACE_ROOT" pull --ff-only --quiet || echo "Couldn't update the workspace; starting with what's there." >&2
fi

cd "$WORKSPACE_ROOT"
exec node dashboard/bin/dashboard.mjs run
