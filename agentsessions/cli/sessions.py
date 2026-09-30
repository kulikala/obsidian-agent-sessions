"""`agent-sessions sessions [--query TEXT] [--agent A] [--limit N] [--all] [--json]`: the sessions of
every enabled agent, newest activity first, each with its status (running, asking, idle, ended) and
the folder it works in. The caller's own session is marked."""
import argparse
import json
import sys
from typing import List

from . import listing

DEFAULT_LIMIT = 20


def main(args: List[str]) -> int:
    p = argparse.ArgumentParser(prog='agent-sessions sessions', description='List sessions')
    p.add_argument('--query', default=None, help='keep sessions whose id, name, folder, agent or status contains TEXT')
    p.add_argument('--agent', choices=('claude', 'codex', 'opencode'), default=None)
    p.add_argument('--limit', type=int, default=DEFAULT_LIMIT, help='at most N sessions (default %d)' % DEFAULT_LIMIT)
    p.add_argument('--all', action='store_true', help='include archived sessions and sub-agent sessions')
    p.add_argument('--json', action='store_true', help='machine-readable output')
    ns = p.parse_args(args)

    rows = listing.collect(include_children=ns.all, include_archived=ns.all)
    if ns.agent:
        rows = [r for r in rows if r['agent'] == ns.agent]
    if ns.query:
        rows = [r for r in rows if listing.matches(r, ns.query)]
    total = len(rows)
    rows = rows[:max(0, ns.limit)]

    if ns.json:
        sys.stdout.write(json.dumps({'sessions': rows, 'total': total}, ensure_ascii=False) + '\n')
        return 0
    if not rows:
        sys.stdout.write('no sessions\n')
        return 0
    for r in rows:
        status = r['status'] + (' (%s)' % r['waiting_for'] if r.get('waiting_for') else '')
        sys.stdout.write('%s  %-8s %-8s %s  [%s]  %s%s\n' % (
            r['id'], r['agent'], status, listing.ago(r['last_activity']), r['cwd'], r['name'],
            '  <- this session' if r['self'] else ''))
    if total > len(rows):
        sys.stdout.write('(%d more; raise --limit or narrow with --query)\n' % (total - len(rows)))
    return 0
