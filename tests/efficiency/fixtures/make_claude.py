"""Writes the committed Claude Code fixtures under `claude/` (run from the repository root:
`python3 -m tests.efficiency.fixtures.make_claude`). Every line comes from `builder`: the
shapes follow real transcripts, the content is made up."""

import os

from tests.efficiency import builder as b

ROOT = os.path.join(os.path.dirname(__file__), 'claude')
START = 1790000000.0


def main() -> None:
    proj = os.path.join(ROOT, '-work-vault')
    sid = b.session_uuid(1)
    m = b.Transcript(sid, START)
    m.preamble(skills=64, instr_lines=30)
    m.prompt('Please tidy the parser module and keep the output format.')
    r = m.tool('Read', file_path='/work/vault/src/parser.py')
    m.call(tools=[r])
    m.result(r, 'x' * 1200)
    # A large Bash output: the model gets a preview, the raw output stays in toolUseResult.
    bash = m.tool('Bash', command='npm test -- --verbose')
    m.call(tools=[bash], text=None)
    preview = ('<persisted-output>\nOutput too large (30.1KB). Full output saved to: '
               '/work/home/.claude/projects/-work-vault/%s/tool-results/b1.txt\n\n'
               'Preview (first 2KB):\n' % sid + 'line of test output\n' * 100 + '...\n</persisted-output>')
    m.result(bash, preview, tool_use_result={'stdout': 'line of test output\n' * 1500,
                                             'stderr': '', 'interrupted': False})
    m.edit('/work/vault/src/parser.py', 'old body', 'new body')
    # The same message.id written twice (a call's line repeated while streaming).
    mid = m.call(text='first draft', output=100)
    m.call(text='first draft', output=180, msg_id=mid, after=0.1)
    # A synthetic line (not an API call).
    m.wait(1)
    rec = m._base('assistant')
    rec['message'] = {'model': '<synthetic>', 'id': 'syn1', 'role': 'assistant',
                      'content': [{'type': 'text', 'text': 'No response requested.'}],
                      'usage': {'input_tokens': 0, 'output_tokens': 0}}
    m.lines.append(rec)
    m.prompt('again', after=60)
    m.edit('/work/vault/src/parser.py', 'new body', 'newer body')
    m.interrupt()
    m.spawn('a1b2c3d4e5f6a7b8')
    spawned_at = m.t
    m.spawn('ahelper-0011223344556677', teammate=True)
    m.prompt('Please write the summary of what changed in the parser.', after=120)
    m.compaction()
    m.call(ctx=40000, fresh=True)
    m.write(os.path.join(proj, sid + '.jsonl'))

    s = b.Transcript(sid, spawned_at - 5, agent_id='a1b2c3d4e5f6a7b8')
    s.raw_user('Look around the parser tests and report.')
    g = s.tool('Grep', pattern='def parse', path='/work/vault/tests')
    s.call(tools=[g])
    s.result(g, 'tests/test_parser.py:3')
    s.call(text='Found it.')
    s.write(os.path.join(proj, sid, 'subagents', 'agent-a1b2c3d4e5f6a7b8.jsonl'))

    t = b.Transcript(sid, spawned_at + 2, agent_id='ahelper-0011223344556677')
    t.raw_user('<teammate-message teammate_id="team-lead">Check the docs.</teammate-message>')
    t.call(text='Checked.')
    t.write(os.path.join(proj, sid, 'subagents', 'agent-ahelper-0011223344556677.jsonl'))


if __name__ == '__main__':
    main()
