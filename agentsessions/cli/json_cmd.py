import json
import sys
from datetime import datetime, timezone
from typing import List

from .. import i18n
from . import json_output


def _print(obj) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')


def _parse_iso(value: str) -> float:
    """Converts ISO8601 to epoch seconds. Assumes UTC when there's no timezone."""
    v = value.strip()
    if v.endswith('Z'):
        v = v[:-1] + '+00:00'
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def main(args: List[str]) -> int:
    if not args:
        sys.stderr.write(i18n.t('cmd.json_usage') + '\n')
        return 2
    sub, rest = args[0], args[1:]

    if sub == 'scan':
        only = None
        if '--only' in rest:
            i = rest.index('--only')
            only = rest[i + 1:]
            if not only:
                sys.stderr.write(i18n.t('cmd.json_id_needs_value') + '\n')
                return 2
        _print(json_output.scan_output(only=only))
        return 0

    if sub == 'live':
        _print(json_output.live_output())
        return 0

    if sub == 'detail':
        if not rest:
            sys.stderr.write(i18n.t('cmd.json_detail_usage') + '\n')
            return 2
        _print(json_output.detail_output(rest[0]))
        return 0

    if sub == 'usage':
        if not rest:
            sys.stderr.write(i18n.t('cmd.json_usage_usage') + '\n')
            return 2
        session_id, opts = rest[0], rest[1:]
        from_ts = None
        to_ts = None
        i = 0
        while i < len(opts):
            opt = opts[i]
            if opt in ('--from', '--to') and i + 1 < len(opts):
                try:
                    value = _parse_iso(opts[i + 1])
                except ValueError:
                    sys.stderr.write(i18n.t('cmd.json_bad_iso', value=opts[i + 1]) + '\n')
                    return 2
                if opt == '--from':
                    from_ts = value
                else:
                    to_ts = value
                i += 2
            else:
                sys.stderr.write(i18n.t('cmd.json_unknown_option', option=opt) + '\n')
                return 2
        _print(json_output.usage_output(session_id, from_ts=from_ts, to_ts=to_ts))
        return 0

    if sub == 'stats':
        _print(json_output.stats_output())
        return 0

    if sub == 'resolve':
        if not rest:
            sys.stderr.write(i18n.t('cmd.json_resolve_usage') + '\n')
            return 2
        agent, opts = rest[0], rest[1:]
        pid, since, cwd = None, None, None
        i = 0
        while i < len(opts):
            opt = opts[i]
            if opt in ('--pid', '--since', '--cwd') and i + 1 < len(opts):
                value = opts[i + 1]
                if opt == '--pid':
                    try:
                        pid = int(value)
                    except ValueError:
                        sys.stderr.write(i18n.t('cmd.json_resolve_bad_pid', value=value) + '\n')
                        return 2
                elif opt == '--since':
                    try:
                        since = float(value)   # epoch seconds
                    except ValueError:
                        try:
                            since = _parse_iso(value)
                        except ValueError:
                            sys.stderr.write(i18n.t('cmd.json_bad_iso', value=value) + '\n')
                            return 2
                else:
                    cwd = value
                i += 2
            else:
                sys.stderr.write(i18n.t('cmd.json_unknown_option', option=opt) + '\n')
                return 2
        if pid is None or since is None or cwd is None:
            sys.stderr.write(i18n.t('cmd.json_resolve_usage') + '\n')
            return 2
        _print(json_output.resolve_output(agent, pid, since, cwd))
        return 0

    sys.stderr.write(i18n.t('cmd.json_unknown_subcommand', sub=sub) + '\n')
    return 2
