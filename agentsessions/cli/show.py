"""`agent-sessions show [ID_OR_NAME] [--json]`: one session's status, last messages, tools and usage.
Without an argument (or with `self`), the caller's own session."""
import argparse
import json
import sys
from datetime import datetime
from typing import Any, Dict, List

from . import json_output, listing


def _when(epoch) -> str:
    return datetime.fromtimestamp(epoch).astimezone().strftime('%Y-%m-%d %H:%M %Z') if epoch else '-'


def gather(row: Dict[str, Any]) -> Dict[str, Any]:
    usage = json_output.usage_output(row['id'])['total']
    return {'session': row, 'detail': json_output.detail_output(row['id']),
            'usage': {k: usage.get(k) for k in ('calls', 'input', 'output', 'cache_read', 'cache_create',
                                                'cost', 'duration', 'context_last', 'estimated', 'unpriced_calls',
                                                'tools')}}


def _unpriced(u: Dict[str, Any]) -> str:
    """' (+N calls without a price)' when the cost leaves some calls out, else ''."""
    n = u.get('unpriced_calls') or 0
    return ' (+%d call%s without a price)' % (n, '' if n == 1 else 's') if n else ''


def render(info: Dict[str, Any]) -> str:
    r, d, u = info['session'], info['detail'], info['usage']
    lines = ['%s%s' % (r['name'], '  <- this session' if r['self'] else ''),
             'ID: %s' % r['id'],
             'Agent: %s' % r['agent'],
             'Folder: %s' % r['cwd'],
             'Status: %s%s' % (r['status'], ' (%s)' % r['waiting_for'] if r.get('waiting_for') else ''),
             'Last activity: %s' % _when(r['last_activity']),
             'Usage: %s calls, input %s, output %s, cache read %s, cache write %s, cost $%.2f%s' % (
                 u['calls'], u['input'], u['output'], u['cache_read'], u['cache_create'], u['cost'] or 0.0,
                 (' (estimated)' if u.get('estimated') else '') + _unpriced(u))]
    if d.get('model'):
        lines.append('Model: %s%s' % (d['model'], ' (%s)' % d['effort'] if d.get('effort') else ''))
    if u.get('tools'):
        lines.append('Tools: %s' % ', '.join('%s x%d' % kv for kv in sorted(u['tools'].items(), key=lambda kv: -kv[1])))
    for label, key in (('Last user message', 'last_user'), ('Last assistant message', 'last_assistant'),
                       ('Last command', 'last_command')):
        if d.get(key):
            lines += ['', '%s:' % label, str(d[key])]
    return '\n'.join(lines) + '\n'


def main(args: List[str]) -> int:
    p = argparse.ArgumentParser(prog='agent-sessions show', description="Show one session's details")
    p.add_argument('session', nargs='?', default='self', help='id, id prefix or name (default: this session)')
    p.add_argument('--json', action='store_true', help='machine-readable output')
    ns = p.parse_args(args)

    rows = listing.collect(include_children=True, include_archived=True)
    try:
        if ns.session == 'self':
            own = listing.own_session_id()
            if not own:
                sys.stderr.write('[ERROR] not running inside an Agent Sessions session; give an id or a name\n')
                return 2
            row = listing.find(rows, own)
        else:
            row = listing.find(rows, ns.session)
    except listing.NotFound as e:
        sys.stderr.write('[ERROR] no session matches "%s"\n' % e)
        return 2
    except listing.Ambiguous as e:
        sys.stderr.write('[ERROR] "%s" matches several sessions; use an id:\n' % e.query)
        for r in e.rows[:10]:
            sys.stderr.write('  %s  %s  %s\n' % (r['id'], r['agent'], r['name']))
        return 2
    info = gather(row)
    sys.stdout.write(json.dumps(info, ensure_ascii=False) + '\n' if ns.json else render(info))
    return 0
