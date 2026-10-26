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
# Either way, with GIT_TOKEN set every start also brings each repos.json repo to its latest
# default branch with git (`snapshot.mjs pull-repos`, in the background once the dashboard
# is starting): snapshot copies become clones, clean clones are fast-forwarded, and one with
# local work is left alone. The token needs read access to those repos too.
#
# The workspace is always fetched with GIT_TOKEN, never with the person's own GitHub sign-in
# (the Machine page's, which git reaches through its credential helper): `-c credential.helper=`
# empties the helper list for those commands. In runs the helper comes first and GIT_TOKEN is
# only the fallback, so a signed-in person pushes as themselves.
#
# plus the DASHBOARD_* settings in references/hosting.md.
set -eu

mkdir -p "$CLAUDE_CONFIG_DIR"
if [ -n "${GH_CONFIG_DIR:-}" ]; then mkdir -p "$GH_CONFIG_DIR"; fi

# The engine's folder in the workspace: .claude/dashboard/engine.json "dir" (dashboard in older workspaces).
engine_dir() {
  node -e 'let d = "dashboard"; try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).dir; const p = typeof v === "string" ? v.split("/") : []; if (p.length && p[0] !== ".claude" && p.every((s) => /^[\w.-]+$/.test(s) && s !== "." && s !== "..")) d = v } catch {} console.log(d)' "$WORKSPACE_ROOT/.claude/dashboard/engine.json"
}

if [ -n "${GIT_TOKEN:-}" ]; then
  # Hand the token to git through askpass, so it's never written into a URL or config file.
  askpass=$(mktemp)
  printf '#!/bin/sh\ncase "$1" in Username*) echo "${GIT_USERNAME:-x-access-token}" ;; *) echo "$GIT_TOKEN" ;; esac\n' > "$askpass"
  chmod 700 "$askpass"
  export GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0
fi

if [ -n "${SNAPSHOT_CONFIG:-}" ]; then
  if ! node --disable-warning=ExperimentalWarning /opt/natterjack/engine/bin/snapshot.mjs install --into "$WORKSPACE_ROOT" --repos; then
    # Start what's there only if it's a whole install, i.e. its stamp names a commit: one
    # that stopped while copying leaves "installing" (a mix of files). Exiting lets the
    # platform restart the container, which retries the install.
    if ! node -e 'try { process.exit(/^[0-9a-f]{7,64}$/.test(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sha) ? 0 : 1) } catch { process.exit(1) }' "$WORKSPACE_ROOT/.snapshot.json" \
       || [ ! -f "$WORKSPACE_ROOT/$(engine_dir)/bin/dashboard.mjs" ]; then
      echo "Couldn't install the workspace from its snapshot." >&2
      exit 1
    fi
    echo "Couldn't update the workspace from its snapshot; starting with what's there." >&2
  fi
else
  # Installed from a snapshot before the switch to WORKSPACE_REPO: make it a clone in place,
  # so the switch is a settings change. The stamp goes last, so a conversion cut off midway is
  # redone on the next start. Checking the default branch out writes over the snapshot's files;
  # ignored files (the ledger with its runs and keys, the repos, node_modules) stay. Files the
  # snapshot left behind after they were deleted upstream are cleaned under .claude/ only (old
  # skills and agents Claude would still load), keeping local state there.
  if [ -n "${WORKSPACE_REPO:-}" ] && [ -f "$WORKSPACE_ROOT/.snapshot.json" ]; then
    echo "Turning the snapshot install at $WORKSPACE_ROOT into a clone of $WORKSPACE_REPO..."
    convert="$WORKSPACE_ROOT/.git-converting"
    rm -rf "$convert" "$WORKSPACE_ROOT/.git"
    if git -c credential.helper= clone --quiet --no-checkout "$WORKSPACE_REPO" "$convert" \
       && mv "$convert/.git" "$WORKSPACE_ROOT/.git" \
       && git -C "$WORKSPACE_ROOT" reset --quiet --hard \
       && git -C "$WORKSPACE_ROOT" clean -fdq -e .claude/ledger/ -e .claude/worktrees/ -e .claude/settings.local.json -- .claude; then
      rm -rf "$convert"
      rm -f "$WORKSPACE_ROOT/.snapshot.json"
    else
      # The snapshot's files are still whole unless the checkout itself failed; start them.
      rm -rf "$convert" "$WORKSPACE_ROOT/.git"
      echo "Couldn't turn the snapshot install into a clone (above); starting with what's there." >&2
    fi
  fi
  if [ -f "$WORKSPACE_ROOT/.snapshot.json" ] && [ -n "${WORKSPACE_REPO:-}" ]; then
    : # still a snapshot install (the conversion above failed): start it as it is
  elif [ ! -d "$WORKSPACE_ROOT/.git" ]; then
    if [ -z "${WORKSPACE_REPO:-}" ]; then
      echo "Set SNAPSHOT_CONFIG (a published snapshot) or WORKSPACE_REPO (the workspace's git URL), or put a clone at $WORKSPACE_ROOT." >&2
      exit 1
    fi
    echo "Cloning the workspace into $WORKSPACE_ROOT..."
    git -c credential.helper= clone --quiet "$WORKSPACE_REPO" "$WORKSPACE_ROOT"
  else
    git -c credential.helper= -C "$WORKSPACE_ROOT" pull --ff-only --quiet || echo "Couldn't update the workspace; starting with what's there." >&2
  fi
fi

if [ -n "${GIT_TOKEN:-}" ]; then
  # In the background, so the dashboard is up at once (the first start clones every repo, which
  # takes minutes); the Repos page shows each repo as it lands. It outlives the exec below: tini
  # (PID 1) takes it over.
  ( node --disable-warning=ExperimentalWarning /opt/natterjack/engine/bin/snapshot.mjs pull-repos --into "$WORKSPACE_ROOT" \
      || echo "Couldn't bring every repo up to date (above)." >&2 ) &
fi

cd "$WORKSPACE_ROOT"
exec node "$(engine_dir)/bin/dashboard.mjs" run
