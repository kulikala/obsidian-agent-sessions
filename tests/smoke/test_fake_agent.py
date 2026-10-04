"""The fake agent on a real PTY: what the smoke test needs of an agent in a terminal tab.

Runs the agent on one end of a PTY pair, sends it the script the smoke test sends (a line of
UTF-8, `size` after a resize, Ctrl+G, `exit`) and reads what comes back. Unix only; the
Windows counterpart is `tests/windows/test_fake_agent_windows.py`.
"""
import fcntl
import os
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FAKE_AGENT = os.path.join(ROOT, 'tools', 'smoke', 'fake_agent.py')
TIMEOUT = 20.0
COLS, ROWS = 100, 30
RESIZED_COLS, RESIZED_ROWS = 64, 24

# The `$VISUAL` this test points at: it appends a line to the file Claude Code's call names
# (`$VISUAL -g <file>:1`), and records the arguments it was handed next to itself.
EDITOR_SOURCE = r'''"""The smoke test's `$VISUAL`: appends a line to the file it is handed."""
import os
import sys

args = sys.argv[1:]
path = ''
for i, arg in enumerate(args):
    if arg == '-g' and i + 1 < len(args):
        path = args[i + 1].split(':')[0]   # `path:line`, as Claude Code passes it
        break
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, 'editor-args.txt'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(args))
with open(path, 'a', encoding='utf-8') as f:
    f.write('EDITED BY TEST\n')
'''


@unittest.skipIf(sys.platform == 'win32', 'Unix only: it drives a real PTY')
class FakeAgentPtyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix='fake-agent-smoke-')
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.editor = os.path.join(self.dir, 'fake_editor.py')
        with open(self.editor, 'w', encoding='utf-8') as f:
            f.write(EDITOR_SOURCE)
        env = dict(os.environ)
        env['VISUAL'] = '%s %s' % (sys.executable, self.editor)   # the agent splits this itself
        env.pop('EDITOR', None)
        env['TMPDIR'] = self.dir      # the prompt file lands here, where the test can look for it
        env.pop('COLUMNS', None)      # the size must come from the PTY, not the environment
        env.pop('LINES', None)
        self.master, slave = os.openpty()
        self.addCleanup(os.close, self.master)
        self.set_size(COLS, ROWS)
        self.proc = subprocess.Popen([sys.executable, FAKE_AGENT], stdin=slave, stdout=slave, stderr=slave,
                                     env=env, cwd=self.dir, start_new_session=True)
        os.close(slave)
        self.addCleanup(self.stop)
        self.out = bytearray()

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(TIMEOUT)

    def set_size(self, cols: int, rows: int) -> None:
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def send(self, data: bytes) -> None:
        os.write(self.master, data)

    def wait_for(self, needle: bytes) -> None:
        deadline = time.time() + TIMEOUT
        while needle not in self.out:
            left = deadline - time.time()
            if left <= 0:
                self.fail('no %r within %gs; the terminal said: %r' % (needle, TIMEOUT, bytes(self.out)))
            ready, _, _ = select.select([self.master], [], [], min(left, 0.5))
            if not ready:
                continue
            data = os.read(self.master, 65536)
            if not data:
                self.fail('the agent closed its terminal; it had said: %r' % bytes(self.out))
            self.out += data

    def test_ready_prompt_and_echo(self) -> None:
        self.wait_for(b'FAKE-AGENT READY')
        self.wait_for(b'> ')
        self.send('hello 日本語\r'.encode('utf-8'))
        self.wait_for('ECHO hello 日本語'.encode('utf-8'))

    def test_size_follows_the_pty(self) -> None:
        self.wait_for(b'FAKE-AGENT READY')
        self.set_size(RESIZED_COLS, RESIZED_ROWS)
        self.send(b'size\r')
        self.wait_for(('SIZE %dx%d' % (RESIZED_COLS, RESIZED_ROWS)).encode('utf-8'))

    def test_ctrl_g_runs_the_editor_and_shows_the_file(self) -> None:
        self.wait_for(b'FAKE-AGENT READY')
        self.send(b'\x07')
        self.wait_for(b'EDITED 0')
        self.wait_for(b'FILE FAKE PROMPT')
        self.wait_for(b'FILE EDITED BY TEST')
        self.wait_for(b'> ')
        with open(os.path.join(self.dir, 'editor-args.txt'), encoding='utf-8') as f:
            args = f.read().split('\n')
        self.assertEqual(len(args), 2)
        self.assertEqual(args[0], '-g')
        self.assertEqual(args[1].rsplit(':', 1)[1], '1')        # `-g <file>:1`, as Claude Code calls it
        target = args[1].rsplit(':', 1)[0]
        self.assertTrue(os.path.samefile(os.path.dirname(target), self.dir), target)   # the temp dir
        self.assertRegex(os.path.basename(target), r'^claude-prompt-smoke-.+\.md$')
        self.assertEqual([n for n in os.listdir(self.dir) if n.startswith('claude-prompt-smoke-')], [],
                         'the prompt file is deleted again')

    def test_exit(self) -> None:
        self.wait_for(b'FAKE-AGENT READY')
        self.send(b'exit\r')
        self.wait_for(b'BYE')
        self.assertEqual(self.proc.wait(TIMEOUT), 0)


if __name__ == '__main__':
    unittest.main()