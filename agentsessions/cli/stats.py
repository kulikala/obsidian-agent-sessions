"""`agent-sessions stats [--json]`: usage in the 5-hour and 7-day windows of every enabled agent
that has them (`json stats`, formatted)."""
import argparse
import json
import sys
import time
from datetime import datetime
from typing import Any, Dict, List

from . import json_output

WINDOW_LABELS = (('five_hour', '5-hour'), ('seven_day', '7-day'))


def _tokens(total: Dict[str, Any]) -> int:
    return sum(total.get(k) or 0 for k in ('input', 'output', 'cache_read', 'cache_create'))


def render(data: Dict[str, Any], now: float) -> str:
    lines: List[str] = []
    for agent, entry in (data.get('agents') or {}).items():
        lines.append(agent)
        for key, label in WINDOW_LABELS:
            w = (entry.get('windows') or {}).get(key)
            if not w:
                continue
            used = w.get('used_percentage')
            end = w.get('end')
            resets = ''
            if end:
                left = int(end - now)
                resets = ', resets in %dh%02dm' % (left // 3600, left % 3600 // 60) if left > 0 else ', reset'
                resets += ' (%s)' % datetime.fromtimestamp(end).astimezone().strftime('%a %H:%M')
            total = w.get('total') or {}
            lines.append('  %s window: %s%s; %d calls, %d tokens, cost $%.2f across %d sessions' % (
                label, '%.0f%% used' % used if used is not None else 'usage unknown', resets,
                total.get('calls') or 0, _tokens(total), total.get('cost') or 0.0, len(w.get('sessions') or [])))
    return '\n'.join(lines) + '\n' if lines else 'no usage windows (no enabled agent reports them)\n'


def main(args: List[str]) -> int:
    p = argparse.ArgumentParser(prog='agent-sessions stats', description='Usage in the 5-hour and 7-day windows')
    p.add_argument('--json', action='store_true', help='machine-readable output (same as `json stats`)')
    ns = p.parse_args(args)
    data = json_output.stats_output()
    sys.stdout.write(json.dumps(data, ensure_ascii=False) + '\n' if ns.json else render(data, time.time()))
    return 0
