"""The fake agent on native Windows: the same script as the Unix test, under a ConPTY.

The Unix test drives a PTY; on Windows the equivalent is a pseudo console, and the daemon's own
`ConPty` (`agentsessions.daemon.conpty`) is what a session really runs in. `$VISUAL` is a `.cmd`
file here, as the plugin's own editor shim is — CreateProcess can't start a batch file, so the
agent has to go through `cmd.exe` — and that `.cmd` is written with CRLF, the line ending
`cmd.exe` reads a batch file with.

Runs only on Windows (CI's windows-latest job); everywhere else the module is skipped.
"""
import os
import select
import shutil
import sys
import tempfile
import time
import unittest
from typing import List

ON_WINDOWS = sys.platform == 'win32'

if ON_WINDOWS:
    from agentsessions.daemon.conpty import ConPty

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FAKE_AGENT = os.path.join(ROOT, 'tools', 'smoke', 'fake_agent.py')
TIMEOUT = 30.0
COLS, ROWS = 100, 30
RESIZED_COLS, RESIZED_ROWS = 64, 24

# What the `.cmd` runs: it appends a line to the file Claude Code's call names
# (`EDITOR -g <file>:1`), and records the arguments it was given next to itself. Only the
# `:<line>` at the end of an argument comes off: the path itself carries a `C:` of its own.
HELPER_SOURCE = r'''"""The smoke test's editor: appends a line to the file it is handed."""
import os
import re
import sys

args = sys.argv[1:]
path = ''
for i, arg in enumerate(args):
    if arg == '-g' and i + 1 < len(args):
        path = re.sub(r':\d+$', '', args[i + 1])   # `path:line`, and the path may hold a `C:`
        break
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, 'editor-args.txt'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(args))
with open(path, 'a', encoding='utf-8') as f:
    f.write('EDITED BY TEST\n')
'''


@unittest.skipUnless(ON_WINDOWS, 'Windows only')
class FakeAgentConPtyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix='fake-agent-smoke-')
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        helper = os.path.join(self.dir, 'helper.py')
        with open(helper, 'w', encoding='utf-8') as f:
            f.write(HELPER_SOURCE)
        shim = os.path.join(self.dir, 'fake-editor.cmd')
        with open(shim, 'w', encoding='utf-8', newline='') as f:
            # CRLF, and `newline=''` so that is what lands in the file: cmd.exe gives up on a
            # batch file with Unix line endings, and reports success without having run any of it.
            f.write('@echo off\r\n"%s" "%s" %%*\r\n' % (os.path.abspath(sys.executable), helper))
        env = dict(os.environ)
        env['VISUAL'] = shim
        env.pop('EDITOR', None)
        env['TMP'] = self.dir       # the prompt file lands here, where the test can look for it
        env['TEMP'] = self.dir
        env.pop('COLUMNS', None)    # the size must come from the console, not the environment
        env.pop('LINES', None)
        self.conpty = ConPty([sys.executable, FAKE_AGENT], env, self.dir, COLS, ROWS)
        self.addCleanup(self.release)
        self.out = bytearray()

    def release(self) -> None:
        self.conpty.kill()   # nothing left to kill after a clean exit; the job closes with the handle
        self.conpty.release()

    def wait_for(self, needle: bytes) -> None:
        deadline = time.time() + TIMEOUT
        while needle not in self.out:
            left = deadline - time.time()
            if left <= 0:
                self.fail('no %r within %gs; the console said: %r' % (needle, TIMEOUT, bytes(self.out)))
            ready, _, _ = select.select([self.conpty.fileno()], [], [], min(left, 0.5))
            if not ready:
                continue
            try:
                data = self.conpty.read(65536)
            except BlockingIOError:
                continue
            if not data:
                self.fail('the agent closed its console; it had said: %r' % bytes(self.out))
            self.out += data

    def wait_for_exit(self, timeout: float = TIMEOUT) -> int:
        deadline = time.time() + timeout
        while self.conpty.poll() is None and time.time() < deadline:
            time.sleep(0.1)
        code = self.conpty.poll()
        self.assertIsNotNone(code, 'the agent did not exit within %gs' % timeout)
        return code

    def file_lines(self) -> List[str]:
        """The lines the agent has read out of the prompt file so far — its content as the
        console shows it."""
        text = bytes(self.out).decode('utf-8', 'replace').replace('\r\n', '\n')
        return [line for line in text.split('\n') if line.startswith('FILE ')]

    def editor_args(self) -> List[str]:
        """The arguments the editor was given, or a failure saying it never ran at all."""
        path = os.path.join(self.dir, 'editor-args.txt')
        self.assertTrue(os.path.isfile(path),
                        'the editor never ran: no editor-args.txt; the console said: %r' % bytes(self.out))
        with open(path, encoding='utf-8') as f:
            return f.read().split('\n')

    def wait_for_file_line(self, needle: bytes) -> None:
        """Waits for a line out of the prompt file, and says what the file actually holds when it
        never comes: an editor that ran and appended nothing is otherwise indistinguishable from
        one that never started."""
        try:
            self.wait_for(needle)
        except AssertionError:
            self.fail('the prompt file never showed %r; the file holds %r and the editor was given %r'
                      % (needle, self.file_lines(), self.editor_args()))

    def test_ready_prompt_and_echo(self) -> None:
        self.wait_for(b'FAKE-AGENT READY')
        self.wait_for(b'> ')
        self.conpty.write('hello 日本語\r'.encode('utf-8'))
        self.wait_for('ECHO hello 日本語'.encode('utf-8'))

    def test_size_follows_the_console(self) -> None:
        self.wait_for(b'FAKE-AGENT READY')
        self.conpty.set_size(RESIZED_COLS, RESIZED_ROWS)
        self.conpty.write(b'size\r')
        self.wait_for(('SIZE %dx%d' % (RESIZED_COLS, RESIZED_ROWS)).encode('utf-8'))

    def test_ctrl_g_runs_the_editor_and_shows_the_file(self) -> None:
        self.wait_for(b'FAKE-AGENT READY')
        self.conpty.write(b'\x07')
        self.wait_for(b'EDITED 0')
        self.wait_for_file_line(b'FILE FAKE PROMPT')
        self.wait_for_file_line(b'FILE EDITED BY TEST')
        self.wait_for(b'> ')
        args = self.editor_args()
        self.assertEqual(len(args), 2, 'the editor was given %r, not `-g <file>:1`' % (args,))
        self.assertEqual(args[0], '-g')
        self.assertEqual(args[1].rsplit(':', 1)[1], '1')     # `-g <file>:1`, as Claude Code calls it
        target = args[1].rsplit(':', 1)[0]
        self.assertTrue(os.path.samefile(os.path.dirname(target), self.dir), target)  # the temp dir
        self.assertRegex(os.path.basename(target), r'^claude-prompt-smoke-.+\.md$')
        self.assertEqual([n for n in os.listdir(self.dir) if n.startswith('claude-prompt-smoke-')], [],
                         'the prompt file is deleted again')

    def test_exit(self) -> None:
        self.wait_for(b'FAKE-AGENT READY')
        self.conpty.write(b'exit\r')
        self.wait_for(b'BYE')
        self.assertEqual(self.wait_for_exit(), 0)


if __name__ == '__main__':
    unittest.main()