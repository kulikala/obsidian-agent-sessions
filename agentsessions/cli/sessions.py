"""`agent-sessions sessions [--query TEXT] [--agent A] [--status S] [--category C | --categories]
[--limit N] [--all] [--json]`: the sessions of every enabled agent, newest activity first, each with its
status (running, asking, idle, ended), category and the folder it works in. Ended sessions (no agent
process; `resume` starts them again) are listed with the rest. The caller's own session is marked.
`--categories` lists the categories instead, with how many sessions each has."""
import argparse
import json
import sys
from typing import List

from . import listing

DEFAULT_LIMIT = 20
STATUSES = ('running', 'asking', 'idle', listing.ENDED)


def main(args: List[str]) -> int:
    p = argparse.ArgumentParser(prog='agent-sessions sessions', description='List sessions')
    p.add_argument('--query', default=None, help='keep sessions whose id, name, folder, agent or status contains TEXT')
    p.add_argument('--agent', choices=('claude', 'codex', 'opencode'), default=None)
    p.add_argument('--status', choices=STATUSES, action='append', default=None,
                   help='keep sessions in this status (repeatable)')
    group = p.add_mutually_exclusive_group()
    group.add_argument('--category', default=None,
                       help="keep sessions in this category (the part of the name before ': '); '' for none")
    group.add_argument('--categories', action='store_true', help='list the categories instead of the sessions')
    p.add_argument('--limit', type=int, default=DEFAULT_LIMIT, help='at most N sessions (default %d)' % DEFAULT_LIMIT)
    p.add_argument('--all', action='store_true', help='include archived sessions and sub-agent sessions')
    p.add_argument('--json', action='store_true', help='machine-readable output')
    ns = p.parse_args(args)

    rows = listing.collect(include_children=ns.all, include_archived=ns.all)
    if ns.agent:
        rows = [r for r in rows if r['agent'] == ns.agent]
    if ns.status:
        rows = [r for r in rows if r['status'] in ns.status]
    if ns.query:
        rows = [r for r in rows if listing.matches(r, ns.query)]

    if ns.categories:
        cats = listing.categories(rows)
        uncategorized = sum(1 for r in rows if not r['category'])
        if ns.json:
            sys.stdout.write(json.dumps({'categories': cats, 'uncategorized': uncategorized},
                                        ensure_ascii=False) + '\n')
            return 0
        if not cats:
            sys.stdout.write('no categories\n')
        for c in cats:
            sys.stdout.write('%s  (%d %s, %d ended)\n' % (
                c['category'], c['sessions'], 'session' if c['sessions'] == 1 else 'sessions', c['ended']))
        if uncategorized:
            sys.stdout.write('(%d without a category)\n' % uncategorized)
        return 0

    if ns.category is not None:
        rows = [r for r in rows if listing.in_category(r, ns.category)]
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
        marks = ''.join((
            '  (archived)' if r['archived'] else '',
            '  (sub-agent)' if r['child'] else '',
            '  <- this session' if r['self'] else ''))
        sys.stdout.write('%s  %-8s %-8s %s  [%s]  %s%s\n' % (
            r['id'], r['agent'], status, listing.ago(r['last_activity']), r['cwd'], r['name'], marks))
    if total > len(rows):
        sys.stdout.write('(%d more; raise --limit or narrow with --query, --status or --category)\n'
                         % (total - len(rows)))
    return 0
