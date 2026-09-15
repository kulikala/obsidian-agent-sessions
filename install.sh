#!/bin/sh
# agent-sessions を手元に入れる：~/bin の symlink、vault の plugins への symlink、Claude Code のフックと statusLine。
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
VAULT="${AGENT_SESSIONS_VAULT:-/path/to/vault}"

mkdir -p "$HOME/bin"
ln -fns "$HERE/bin/agent-sessions" "$HOME/bin/agent-sessions"
echo "linked: $HOME/bin/agent-sessions"

mkdir -p "$VAULT/.obsidian/plugins"
ln -fns "$HERE/plugin" "$VAULT/.obsidian/plugins/agent-sessions"
echo "linked: $VAULT/.obsidian/plugins/agent-sessions"

if [ ! -f "$HERE/plugin/main.js" ]; then
  echo "plugin/main.js が無い。cd plugin && npm install && npm run build を先に実行する" >&2
fi

"$HERE/bin/agent-sessions" setup "$@"
