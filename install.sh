#!/bin/sh
# agent-sessions を手元に入れる：~/bin の symlink、vault の plugins への symlink、Claude Code のフックと statusLine。
# vault は既定値を持たない——env AGENT_SESSIONS_VAULT か、第 1 引数で渡す（T-80）。
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

mkdir -p "$VAULT/.obsidian/plugins"
ln -fns "$HERE/plugin" "$VAULT/.obsidian/plugins/agent-sessions"
echo "linked: $VAULT/.obsidian/plugins/agent-sessions"

if [ ! -f "$HERE/plugin/main.js" ]; then
  echo "plugin/main.js が無い。cd plugin && npm install && npm run build を先に実行する" >&2
fi

"$HERE/bin/agent-sessions" setup "$@"
