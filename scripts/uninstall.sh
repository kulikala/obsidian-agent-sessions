#!/bin/sh
# Removes agent-sessions from this machine: stops the daemon, removes only its own
# entries from ~/.claude/settings.json and keybindings.json (agent-sessions
# setup --remove), and removes the ~/bin symlinks. With a vault — as an argument or
# via the env var AGENT_SESSIONS_VAULT (same convention as install.sh) — it also
# removes that vault's plugin symlink; a plugin installed from Community plugins is
# removed from Obsidian instead.
#
# --force  stop even if sessions are running, without asking for confirmation
# --purge  also delete the runtime dir (~/.agents/sessions/) and, with a vault, the
#          ledger (<vault>/.agents/sessions/)
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
AS="$HERE/bin/agent-sessions"

VAULT="${AGENT_SESSIONS_VAULT:-}"
FORCE=0
PURGE=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --purge) PURGE=1 ;;
    *)
      if [ -z "$VAULT" ]; then
        VAULT="$a"
      fi
      ;;
  esac
done
# 1. Stop the daemon. Ask for confirmation first if any session is still running,
#    unless --force was given.
n="$("$AS" daemon --running-count 2>/dev/null)" || n=0
case "$n" in ''|*[!0-9]*) n=0 ;; esac
if [ "$n" -gt 0 ]; then
  if [ "$FORCE" -ne 1 ]; then
    printf '%s session(s) are still running. Stop anyway? [y/N] ' "$n" >&2
    read -r ans
    case "$ans" in
      y|Y|yes|YES) ;;
      *) echo "Aborted (pass --force to skip this confirmation)." >&2; exit 1 ;;
    esac
  fi
fi
"$AS" daemon --stop
echo "daemon: stopped (a no-op if it wasn't running)"

# 2. Remove only our own entries from settings.json and keybindings.json.
"$AS" setup --remove

# 3. Remove the symlinks. Leave a path in place (with a note) if it isn't actually a
#    symlink (e.g. someone replaced it by hand).
for f in "$HOME/bin/agent-sessions" "$HOME/bin/agent-sessions-code"; do
  if [ -L "$f" ]; then
    rm "$f"
    echo "unlinked: $f"
  elif [ -e "$f" ]; then
    echo "$f is not a symlink, so it was left in place (check it and remove it by hand)." >&2
  fi
done

if [ -n "$VAULT" ]; then
  plugin_link="$VAULT/.obsidian/plugins/agent-sessions"
  if [ -L "$plugin_link" ]; then
    rm "$plugin_link"
    echo "unlinked: $plugin_link"
  elif [ -e "$plugin_link" ]; then
    echo "$plugin_link is not a symlink, so it was left in place (remove the plugin from Obsidian's Community plugins, or by hand)." >&2
  fi
fi

# 4. Only with --purge, delete the runtime dir and the ledger.
if [ "$PURGE" -eq 1 ]; then
  runtime_dir="${AGENT_SESSIONS_RUNTIME_DIR:-$HOME/.agents/sessions}"
  rm -rf "$runtime_dir"
  echo "purged: $runtime_dir"
  if [ -n "$VAULT" ]; then
    rm -rf "$VAULT/.agents/sessions"
    echo "purged: $VAULT/.agents/sessions"
  fi
fi

echo "done"
