#!/bin/sh
# Installs agent-sessions locally: symlinks it into ~/bin and sets up Claude Code's hooks
# and statusLine. With a vault — via the env var AGENT_SESSIONS_VAULT or as the first
# argument — it also symlinks this clone's plugin into that vault's plugins (installing
# from source); without one, the plugin is expected to come from Obsidian's Community
# plugins and is left alone.
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"

VAULT="${AGENT_SESSIONS_VAULT:-}"
if [ -z "$VAULT" ] && [ $# -gt 0 ]; then
  case "$1" in
    -*) ;;
    *) VAULT="$1"; shift ;;
  esac
fi

mkdir -p "$HOME/bin"
ln -fns "$HERE/bin/agent-sessions" "$HOME/bin/agent-sessions"
echo "linked: $HOME/bin/agent-sessions"
ln -fns "$HERE/bin/agent-sessions-code" "$HOME/bin/agent-sessions-code"
echo "linked: $HOME/bin/agent-sessions-code"

case ":$PATH:" in
  *":$HOME/bin:"*) ;;
  *)
    echo "$HOME/bin is not on PATH. Add this to your shell's startup file" >&2
    echo "(~/.bashrc, ~/.profile, etc):" >&2
    echo "  export PATH=\"\$HOME/bin:\$PATH\"" >&2
    echo "then open a new shell (or run hash -r in the current one)." >&2
    ;;
esac

if [ -n "$VAULT" ]; then
  mkdir -p "$VAULT/.obsidian/plugins"
  ln -fns "$HERE/plugin" "$VAULT/.obsidian/plugins/agent-sessions"
  echo "linked: $VAULT/.obsidian/plugins/agent-sessions"

  if [ ! -f "$HERE/plugin/main.js" ]; then
    echo "plugin/main.js is missing. Run cd plugin && npm install && npm run build first." >&2
  fi
else
  echo "no vault given: the plugin itself is not linked (install it from Obsidian's Community plugins)"
fi

"$HERE/bin/agent-sessions" setup "$@"
