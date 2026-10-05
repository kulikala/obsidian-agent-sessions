"""Regenerates `activity-equivalence.json`: a synthetic week of sessions in both forms `json activity`
gives, so the plugin's client-side join can be checked against the program's own join.

Run from the repo root: `python3 plugin/test/fixtures/make-activity-fixture.py`.
"""
import json
import os
import random
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')))

from agentsessions.sessions import activity  # noqa: E402

DAY = 86400
START = 1_790_000_000.0     # an arbitrary Monday-ish instant
RANGE = (START, START + 7 * DAY)


def session(i: int, rnd: random.Random) -> dict:
    turns = []
    for d in range(7):
        base = START + d * DAY
        for _ in range(rnd.randint(0, 6)):
            s = base + rnd.uniform(0, 22 * 3600)
            length = rnd.choice([0, 20, 90, 400, 1500, 4000])
            kind = rnd.choice(['prompt', 'prompt', 'answer'])
            segs = [[s, s + length]]
            if rnd.random() < 0.3:    # the agent carried on after a long silence
                s2 = s + length + rnd.uniform(2400, 9000)
                segs.append([s2, s2 + rnd.choice([30, 600])])
            turns.append([s, segs[-1][1], 'prompt %d' % rnd.randint(0, 99), kind,
                          'reply %d' % rnd.randint(0, 99), segs])
        if rnd.random() < 0.4:        # a sub-agent run
            s = base + rnd.uniform(0, 20 * 3600)
            turns.append([s, s + rnd.choice([300, 3000]), '', 'subagent', '', [[s, s + rnd.choice([300, 3000])]]])
    return {'id': 'session-%d' % i, 'turns': turns}


def main() -> None:
    rnd = random.Random(7)
    sessions = [session(i, rnd) for i in range(12)]
    out = {'range': list(RANGE), 'gaps': [30, 60, 120], 'sessions': []}
    for s in sessions:
        for t in s['turns']:      # a sub-agent run's segment is its own turn range
            if t[3] == 'subagent':
                t[5] = [[t[0], t[1]]]
        turn_list, runs = activity.raw_runs(s['turns'], *RANGE)
        joined = {str(g): activity.clip_spans(activity.join_turns(s['turns'], g * 60.0), *RANGE) for g in (30, 60, 120)}
        out['sessions'].append({'id': s['id'], 'turns': turn_list, 'runs': runs, 'joined': joined})
    path = os.path.join(os.path.dirname(__file__), 'activity-equivalence.json')
    with open(path, 'w') as f:
        json.dump(out, f)


if __name__ == '__main__':
    main()
