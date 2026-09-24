#!/bin/sh
# agent-sessions を手元から外す：デーモンを止め、~/.claude/settings.json・keybindings.json
# から自分の分だけ取り除き（agent-sessions setup --remove）、~/bin と vault の plugins の
# symlink を外す。vault は引数か env AGENT_SESSIONS_VAULT で必須（install.sh と同じ約束）。
#
# --force  動いているセッションがあっても確認せずに止める
# --purge  ランタイム（~/.agents/sessions/）と台帳（<vault>/.agents/sessions/）も消す
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
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
if [ -z "$VAULT" ]; then
  echo "usage: $0 <vault path> [--force] [--purge]   (or set AGENT_SESSIONS_VAULT)" >&2
  exit 1
fi

# 1. デーモンを止める。動いているセッションがあれば --force が無い限り確認を求める。
n="$("$AS" daemon --running-count 2>/dev/null)" || n=0
case "$n" in ''|*[!0-9]*) n=0 ;; esac
if [ "$n" -gt 0 ]; then
  if [ "$FORCE" -ne 1 ]; then
    printf '動いているセッションが %s 件あります。それでも止めますか？ [y/N] ' "$n" >&2
    read -r ans
    case "$ans" in
      y|Y|yes|YES) ;;
      *) echo "中止した（--force で確認を飛ばせる）" >&2; exit 1 ;;
    esac
  fi
fi
"$AS" daemon --stop
echo "daemon: 止めた（動いていなければ何もしていない）"

# 2. settings.json・keybindings.json から自分の分だけ取り除く。
"$AS" setup --remove

# 3. symlink を外す。symlink でなければ（手で置き換えられている等）消さずに案内する。
for f in "$HOME/bin/agent-sessions" "$HOME/bin/agent-sessions-code"; do
  if [ -L "$f" ]; then
    rm "$f"
    echo "unlinked: $f"
  elif [ -e "$f" ]; then
    echo "$f は symlink ではないので残した（中身を確かめて手で消す）" >&2
  fi
done

plugin_link="$VAULT/.obsidian/plugins/agent-sessions"
if [ -L "$plugin_link" ]; then
  rm "$plugin_link"
  echo "unlinked: $plugin_link"
elif [ -e "$plugin_link" ]; then
  echo "$plugin_link は symlink ではないので残した（中身を確かめて手で消す）" >&2
fi

# 4. --purge のときだけ、ランタイムと台帳を消す。
if [ "$PURGE" -eq 1 ]; then
  runtime_dir="${AGENT_SESSIONS_RUNTIME_DIR:-$HOME/.agents/sessions}"
  rm -rf "$runtime_dir"
  echo "purged: $runtime_dir"
  rm -rf "$VAULT/.agents/sessions"
  echo "purged: $VAULT/.agents/sessions"
fi

echo "done"
