"""The account's Claude usage as Claude Code's own `/usage` reports it -- the fallback for when the
status files (`usage.stats.windows_from_status`) can't tell.

The status files only change when a Claude Code session on this machine gets a response, so they
miss everything used elsewhere (claude.ai, another machine) and go stale at a reset. `/usage` asks
the server instead and covers the whole account. Run as
`claude -p /usage --no-session-persistence --output-format stream-json --verbose`, it calls no
model (no cost, no usage), writes no transcript, and carries the readings in a synthetic assistant
event's `usage_report.rate_limits.limits`: `{kind, percent, resets_at (ISO 8601)}`, where `kind`
`session` is the 5-hour window and `weekly_all` the 7-day one; `resets_at` is null for a window
that isn't running (no request since its last reset). That shape isn't a published
interface, so anything unexpected reads as "no reading" and the status files stay the only source.

A run takes a few seconds and starts Claude Code, so it's rate-limited: at most one attempt per
`MIN_INTERVAL_SECONDS`, failed attempts included. The last attempt and the last good reading are
kept in `~/.agents/sessions/claude-usage.json`.
"""
import json
import os
import shutil
import subprocess
import tempfile
from datetime import datetime
from typing import Callable, Dict, Optional

from .. import config

MIN_INTERVAL_SECONDS = 5 * 60
TIMEOUT_SECONDS = 30
# No MCP servers and no user settings (their hooks): `/usage` needs neither, and they'd only slow
# the run down or start something. `--bare` would skip them too, but it never reads the login.
ARGS = ['-p', '/usage', '--no-session-persistence', '--output-format', 'stream-json', '--verbose',
        '--strict-mcp-config', '--setting-sources', 'project']
_KINDS = {'session': 'five_hour', 'weekly_all': 'seven_day'}


def _parse_iso(value) -> Optional[float]:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None


def parse_limits(limits) -> Dict[str, dict]:
    """`{'five_hour': {'used_percentage', 'resets_at'}, 'seven_day': {...}}` from a
    `rate_limits.limits` list, keeping only well-formed entries of the two known kinds.
    `resets_at` is `None` for a window that isn't running."""
    out: Dict[str, dict] = {}
    if not isinstance(limits, list):
        return out
    for item in limits:
        if not isinstance(item, dict) or item.get('scope'):
            continue
        key = _KINDS.get(item.get('kind'))
        pct = item.get('percent')
        raw_reset = item.get('resets_at')
        resets_at = _parse_iso(raw_reset)
        if key is None or isinstance(pct, bool) or not isinstance(pct, (int, float)) \
                or (raw_reset is not None and resets_at is None):
            continue
        out.setdefault(key, {'used_percentage': float(pct), 'resets_at': resets_at})
    return out


def parse_stream(text: str) -> Dict[str, dict]:
    """The readings in a `--output-format stream-json` run's stdout (`parse_limits`); `{}` if none."""
    for line in text.splitlines():
        if 'rate_limits' not in line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        report = event.get('usage_report') if isinstance(event, dict) else None
        rate_limits = report.get('rate_limits') if isinstance(report, dict) else None
        found = parse_limits(rate_limits.get('limits')) if isinstance(rate_limits, dict) else {}
        if found:
            return found
    return {}


def _login_path() -> Optional[str]:
    """The login shell's PATH, as the plugin passes it (Obsidian's own PATH can lack it)."""
    return os.environ.get('AGENT_SESSIONS_LOGIN_PATH') or None


def find_claude() -> Optional[str]:
    """Claude Code's executable: the path set in the plugin's settings, then the login shell's
    PATH, then this process's PATH, then where its installers put it."""
    configured = os.environ.get('AGENT_SESSIONS_CLAUDE_BIN', '')
    if configured and os.path.isfile(configured):
        return configured
    login = _login_path()
    found = (shutil.which('claude', path=login) if login else None) or shutil.which('claude')
    if found:
        return found
    home = os.path.expanduser('~')
    for candidate in (os.path.join(home, '.local', 'bin', 'claude'), os.path.join(home, '.claude', 'local', 'claude'),
                      '/opt/homebrew/bin/claude', '/usr/local/bin/claude'):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def run_usage(bin_path: str) -> str:
    """stdout of one `/usage` run, from an empty folder (so no project's settings or hooks apply)
    and with only the login environment (none of a calling session's own variables)."""
    from ..agents import launch
    env = launch.inherited_env(os.environ)
    if _login_path():
        env['PATH'] = _login_path()
    with tempfile.TemporaryDirectory(prefix='agent-sessions-usage-') as cwd:
        return subprocess.run([bin_path] + ARGS, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              timeout=TIMEOUT_SECONDS).stdout.decode('utf-8', 'replace')


def load(path: Optional[str] = None) -> dict:
    """`{'attempted_at', 'fetched_at', 'windows'}` as last saved; `{}` if missing or unreadable."""
    try:
        with open(path or config.CLAUDE_USAGE_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _save(data: dict, path: str) -> None:
    try:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.claude-usage.', suffix='.tmp')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except OSError:
        pass


def readings(now: float, needed: bool, path: Optional[str] = None,
             runner: Optional[Callable[[], str]] = None) -> Optional[dict]:
    """The last good `/usage` reading, `{'fetched_at', 'windows'}`, or `None`. When `needed` and the
    last attempt is at least `MIN_INTERVAL_SECONDS` old, runs `/usage` first (`runner`, by default
    `run_usage` on `find_claude()`); the attempt is recorded before running, so concurrent callers
    don't all start one."""
    path = path or config.CLAUDE_USAGE_PATH
    data = load(path)
    attempted = data.get('attempted_at')
    due = not isinstance(attempted, (int, float)) or now - attempted >= MIN_INTERVAL_SECONDS
    if needed and due:
        data['attempted_at'] = now
        _save(data, path)
        if runner is None:
            bin_path = find_claude()
            runner = (lambda: run_usage(bin_path)) if bin_path else None
        try:
            windows = parse_stream(runner()) if runner else {}
        except (OSError, subprocess.SubprocessError):
            windows = {}
        if windows:
            data['fetched_at'] = now
            data['windows'] = windows
            _save(data, path)
    fetched = data.get('fetched_at')
    windows = data.get('windows')
    if not isinstance(fetched, (int, float)) or not isinstance(windows, dict):
        return None
    return {'fetched_at': float(fetched), 'windows': windows}
