"""A stand-in for a coding agent CLI (Claude Code and friends), for the smoke tests.

The smoke test drives a real agent in a terminal tab. That needs a program that starts
instantly, answers a fixed script, and never writes a transcript or a config of its own —
and one that is not a real agent, whose behaviour changes with the network and the weather.
This is that program: it runs on a PTY (Unix) or a ConPTY (Windows), reads one byte at a
time and echoes it the way a line editor would, answers `size` with the terminal's size,
opens `$VISUAL` on Ctrl+G the way Claude Code does (`-g <file>:1`, on a temporary
`claude-prompt-smoke-*.md`), and quits on `exit`. The one file it writes is that temporary
prompt, which it deletes again. Standard library only.

    $ python3 tools/smoke/fake_agent.py
    FAKE-AGENT READY
    > 
"""

import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from typing import List, Optional

IS_WINDOWS = sys.platform == 'win32'

if not IS_WINDOWS:
    import termios

PROMPT = b'> '         # no newline: the agent is waiting, not done
NEWLINE = b'\r\n' if IS_WINDOWS else b'\n'   # a ConPTY console does not add the carriage return
CTRL_G = 0x07
FAKE_PROMPT = 'FAKE PROMPT'   # what the prompt file holds


def _write(data: bytes) -> None:
    """Bytes as they go out. Written unencoded: an echoed UTF-8 character can be half
    arrived, and the terminal is what puts the bytes back together."""
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def _say(text: str) -> None:
    _write(text.encode('utf-8', 'replace') + NEWLINE)


def _size() -> str:
    """`SIZE <cols>x<rows>`, from the terminal the agent runs in. `shutil.get_terminal_size`
    is the fallback: it also honours `$COLUMNS`/`$LINES`, which are not the terminal."""
    try:
        size = os.get_terminal_size(sys.stdout.fileno())
    except OSError:
        size = shutil.get_terminal_size()
    return 'SIZE %dx%d' % (size.columns, size.lines)


def _run_editor(path: str) -> int:
    """`$VISUAL -g <path>:1`, exactly the call Claude Code makes: the editor it opens is a
    GUI one (`code`, `agent-sessions-code`), so it gets a file and a line, not stdin."""
    editor = os.environ.get('VISUAL') or os.environ.get('EDITOR') or ''
    if not editor:
        return 127   # nothing to run, like a shell's "command not found"
    target = '%s:1' % path
    if IS_WINDOWS:
        if editor.lower().endswith(('.cmd', '.bat')):
            # CreateProcess can't start a batch file; `cmd.exe /s /c` needs the whole command
            # quoted (the daemon's own ConPTY wrapper, `conpty.command_line`, does the same).
            comspec = os.environ.get('COMSPEC') or 'cmd.exe'
            return subprocess.call('%s /d /s /c "%s"' % (
                comspec, subprocess.list2cmdline([editor, '-g', target])))
        return subprocess.call([editor, '-g', target])
    return subprocess.call(shlex.split(editor) + ['-g', target])


def _edit() -> None:
    """Ctrl+G: put a prompt on disk, hand it to the editor, show what came back."""
    fd, path = tempfile.mkstemp(prefix='claude-prompt-smoke-', suffix='.md')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(FAKE_PROMPT + '\n')
    try:
        code = _run_editor(path)
        _say('EDITED %d' % code)
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f.read().splitlines():
                _say('FILE ' + line)
    finally:
        os.unlink(path)


class _Cbreak:
    """Bytes as they are typed, with no echo from the line discipline: the agent reads one
    byte at a time and echoes printable characters itself. The terminal is put back on the
    way out, however the agent leaves."""

    def __init__(self, fd: int) -> None:
        self._fd = fd
        self._saved: Optional[List] = None

    def __enter__(self) -> None:
        self._saved = termios.tcgetattr(self._fd)
        mode = list(self._saved)
        mode[3] &= ~(termios.ECHO | termios.ICANON)   # lflag
        mode[6][termios.VMIN] = 1
        mode[6][termios.VTIME] = 0
        termios.tcsetattr(self._fd, termios.TCSADRAIN, mode)

    def __exit__(self, *exc: object) -> None:
        if self._saved is not None:
            termios.tcsetattr(self._fd, termios.TCSADRAIN, self._saved)


def _answer(line: bytes) -> bool:
    """One complete line. True when the agent is done."""
    text = line.decode('utf-8', 'replace')
    command = text.strip()
    if command == 'size':
        _say(_size())
    elif command == 'exit':
        _say('BYE')
        return True
    else:
        _say('ECHO ' + text)
    return False


def serve() -> int:
    _say('FAKE-AGENT READY')
    _write(PROMPT)
    line = bytearray()
    while True:
        # A console (a ConPTY one included) hands over the bytes the terminal sent, and
        # b'' is the terminal going away.
        byte = sys.stdin.buffer.read(1)
        if not byte:
            return 0
        if byte[0] == CTRL_G:   # Ctrl+G, as the terminal sends it: one byte, not a chord
            _edit()
            _write(PROMPT)
            continue
        if byte in (b'\r', b'\n'):
            _write(NEWLINE)
            if _answer(bytes(line)):
                return 0
            del line[:]
            _write(PROMPT)
            continue
        line += byte
        _write(byte)


def main() -> int:
    if IS_WINDOWS:
        return serve()
    with _Cbreak(sys.stdin.fileno()):
        return serve()


if __name__ == '__main__':
    sys.exit(main())