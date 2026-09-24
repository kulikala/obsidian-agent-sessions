#!/bin/sh
# Installs agent-sessions locally: symlinks it into ~/bin, symlinks the plugin into the
# vault's plugins, and sets up Claude Code's hooks and statusLine.
# The vault has no default — pass it via the env var AGENT_SESSIONS_VAULT or as the
# first argument.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"

VAULT="${AGENT_SESSIONS_VAULT:-}"
if [ -z "$VAULT" ] && [ $# -gt 0 ]; then
  VAULT="$1"
  shift
fi
if [ -z "$VAULT" ]; then
  echo "usage: $0 <vault path>   (or set AGENT_SESSIONS_VAULT)" >&2
  exit 1
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

mkdir -p "$VAULT/.obsidian/plugins"
ln -fns "$HERE/plugin" "$VAULT/.obsidian/plugins/agent-sessions"
echo "linked: $VAULT/.obsidian/plugins/agent-sessions"

if [ ! -f "$HERE/plugin/main.js" ]; then
  echo "plugin/main.js is missing. Run cd plugin && npm install && npm run build first." >&2
fi

"$HERE/bin/agent-sessions" setup "$@"
