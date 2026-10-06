"""Synthetic histories shared by the task, detector and output tests.

`history(root, lang)` writes a 14-day history of short sessions (enough prompts for the
baselines) plus one scenario session whose turns hit each rework rule and each task boundary
once. The prompts are filler in `lang`; the structure (times, lengths relative to the
baselines, tools, files) is the same in every language, so the outcome must be too.
"""

import os
from typing import Dict

from tests.efficiency import builder as b

NOW = 1790000000.0
DAY = 86400.0
LONG = 60       # estimated tokens of an ordinary prompt
SCENARIO = b.session_uuid(999)


def baseline_sessions(root: str, lang: str, count: int = 70, prompts_each: int = 2,
                      start: float = NOW - 13 * DAY) -> None:
    """`count` short sessions spread over the window, each `prompts_each` ordinary prompts."""
    step = (12 * DAY) / max(count, 1)
    for i in range(count):
        sid = b.session_uuid(100 + i)
        t = b.Transcript(sid, start + i * step)
        for j in range(prompts_each):
            t.prompt(b.text_of(lang, LONG), after=90 if j else 1)
            t.read('/work/vault/notes/n%d.md' % i)
            t.call(text='done')
        t.write(os.path.join(b.project_dir(root), sid + '.jsonl'))


def scenario(root: str, lang: str, start: float = NOW - 2 * DAY) -> Dict[str, str]:
    """The scenario session; returns the uuids of its prompts by turn letter."""
    long_text = b.text_of(lang, LONG)
    short = b.SHORT[lang]
    t = b.Transcript(SCENARIO, start)
    t.preamble()
    p = {}
    # Task 1
    p['A'] = t.prompt(long_text)
    t.read('/work/vault/src/a.py')
    t.edit('/work/vault/src/a.py', 'a0', 'a1')
    p['B'] = t.prompt(short, after=60)                  # rule 1: short, soon, same file again
    t.edit('/work/vault/src/a.py', 'a1', 'a2')
    p['C'] = t.prompt(long_text, after=60)              # long: not rework
    t.edit('/work/vault/src/a.py', 'a2', 'a3')
    p['D'] = t.prompt(short, after=20 * 60)             # 20 minutes later: not rework, same task
    t.edit('/work/vault/src/a.py', 'a3', 'a4')
    p['E'] = t.prompt(short, after=60)                  # another file: not rework
    t.edit('/work/vault/src/b.py', 'b0', 'b1')
    # Task 2: two hours later, other files
    p['F'] = t.prompt(long_text, after=2 * 3600)
    t.read('/work/vault/src/c.py')
    t.edit('/work/vault/src/c.py', 'c0', 'c1')
    p['G'] = t.prompt(short, after=60)                  # rules 1 and 2: puts c0 back
    t.edit('/work/vault/src/c.py', 'c1', 'c0')
    t.interrupt()
    p['H'] = t.prompt(long_text, after=60)              # rule 3: after an interruption
    t.read('/work/vault/src/d.py')
    p['I'] = t.prompt(long_text, after=2 * 3600)        # long gap, but c.py again: same task
    t.read('/work/vault/src/c.py')
    # Task 3
    p['J'] = t.prompt(long_text, after=2 * 3600)
    t.read('/work/vault/src/e.py')
    t.call(text='done')
    t.write(os.path.join(b.project_dir(root), SCENARIO + '.jsonl'))
    return p


def history(root: str, lang: str = 'en', baseline_count: int = 70) -> Dict[str, str]:
    baseline_sessions(root, lang, count=baseline_count)
    return scenario(root, lang)
