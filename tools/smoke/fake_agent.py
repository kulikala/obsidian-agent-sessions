"""A stand-in for a coding agent CLI (Claude Code and friends), for the smoke tests.

The smoke test drives a real agent in a terminal tab. That needs a program that starts
instantly, answers a fixed script, and never writes a transcript or a config of its own —
and one that is not a real agent, whose behaviour changes with the network and the weather.
This is that program: it runs on a PTY (Unix) or a ConPTY (Windows), reads one keystroke at a
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

if IS_WINDOWS:
    import ctypes
    import ctypes.wintypes as w
    import msvcrt

    STD_INPUT_HANDLE = -10
    ENABLE_PROCESSED_INPUT = 0x0001
    ENABLE_LINE_INPUT = 0x0002
    ENABLE_ECHO_INPUT = 0x0004
    ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200

    # The three console calls the raw mode needs. `w.HANDLE` is `c_void_p`: a HANDLE is
    # nothing but a pointer-sized value on the way in.
    _k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    _k32.GetStdHandle.argtypes = [w.DWORD]
    _k32.GetStdHandle.restype = w.HANDLE
    _k32.GetConsoleMode.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
    _k32.GetConsoleMode.restype = w.BOOL
    _k32.SetConsoleMode.argtypes = [w.HANDLE, w.DWORD]
    _k32.SetConsoleMode.restype = w.BOOL

PROMPT = b'> '         # no newline: the agent is waiting, not done
NEWLINE = b'\r\n' if IS_WINDOWS else b'\n'   # a ConPTY console does not add the carriage return
CTRL_G = 0x07
FAKE_PROMPT = 'FAKE PROMPT'   # what the prompt file holds
WEOF = '\uffff'   # what `msvcrt.getwch` hands back when the console has nothing left to give
KEY_PREFIXES = ('\x00', '\xe0')   # an arrow or a function key: the prefix, then the scan code


def _write(data: bytes) -> None:
    """Bytes as they go out, already encoded: an echoed UTF-8 character can be half arrived, and
    the terminal is what puts the bytes back together. Windows included — a ConPTY reads what the
    agent writes as UTF-8 whatever its code page is, which is why this never goes through
    `sys.stdout`'s own encoding."""
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
            # CreateProcess can't start a batch file; `cmd.exe /d /s /c` needs the whole command
            # quoted (the daemon's own ConPTY wrapper, `conpty.command_line`, does the same), and
            # `list2cmdline` quotes every argument that needs it — the file path and its `:<line>`
            # among them, so the editor is given the one path, whole.
            comspec = os.environ.get('COMSPEC') or 'cmd.exe'
            return subprocess.call('%s /d /s /c "%s"' % (
                subprocess.list2cmdline([comspec]), subprocess.list2cmdline([editor, '-g', target])))
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


class _Input:
    """What the agent reads from: one keystroke at a time, and a terminal to put back afterwards.

    A keystroke comes back differently on each platform — a Unix terminal's bytes, a Windows
    console's characters — but the agent speaks bytes either way, so a source only has to turn a
    key into the bytes a Unix terminal would have delivered, or say that there are no more.
    """

    def read_key(self) -> Optional[bytes]:
        raise NotImplementedError


class _Cbreak(_Input):
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

    def read_key(self) -> Optional[bytes]:
        """The terminal's own byte for the next key; b'' when the terminal goes away."""
        return sys.stdin.buffer.read(1)


class _RawConsole(_Input):
    """The Windows half of `_Cbreak`: keystrokes as they are typed, with no echo from the console.

    A console starts in cooked mode: `ENABLE_LINE_INPUT` holds every byte back until Enter
    arrives, `ENABLE_ECHO_INPUT` types them onto the screen itself (so the agent's own echo
    lands doubled, and a Ctrl+G arrives as the text `^G`), and `ENABLE_PROCESSED_INPUT` gives
    Ctrl+C to the console instead of the agent. Clearing all three and asking for VT input
    leaves the agent echoing exactly what it read. The mode is put back on the way out,
    however the agent leaves; when stdin is not a console at all (a pipe, as when a test drives
    the agent with plain subprocesses) there is nothing to change and nothing to restore.

    Keystrokes are read as characters, not as the bytes on stdin, because a console has no
    UTF-8 bytes to offer: the pseudo console has turned what was typed into key events already,
    and reading those back with `ReadFile` encodes them in the console's own code page, so
    Japanese arrives as something else or not at all. `msvcrt.getwch` asks for the character
    itself, and the console answers in Unicode whatever its code page says.
    """

    def __init__(self) -> None:
        self._handle: Optional[int] = None
        self._mode: Optional[int] = None

    def __enter__(self) -> None:
        if not IS_WINDOWS:
            return
        handle = _k32.GetStdHandle(STD_INPUT_HANDLE)
        mode = w.DWORD()
        if not _k32.GetConsoleMode(handle, ctypes.byref(mode)):
            return   # not a console: the bytes arrive as they are written
        raw = mode.value & ~(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT)
        raw |= ENABLE_VIRTUAL_TERMINAL_INPUT
        if not _k32.SetConsoleMode(handle, raw):
            return   # the mode stays what it was, so there is nothing to restore either
        self._handle, self._mode = handle, mode.value

    def __exit__(self, *exc: object) -> None:
        if self._handle is not None and self._mode is not None:
            _k32.SetConsoleMode(self._handle, self._mode)

    def read_key(self) -> Optional[bytes]:
        """The next keystroke as the bytes a Unix terminal would have handed over; None at the end
        of the input. An arrow or a function key is two keys, not one: a `\\x00`/`\\xe0` prefix and
        the scan code behind it. Neither is a character, and the agent has no use for either."""
        if self._handle is None:
            return sys.stdin.buffer.read(1)   # no console: the bytes arrive as they are written
        while True:
            ch = self._getwch()
            if ch is None:
                return None
            if ch in KEY_PREFIXES:
                self._getwch()
                continue
            return ch.encode('utf-8', 'replace')

    @staticmethod
    def _getwch() -> Optional[str]:
        """One key as a character, or None when the console has nothing more to give. Ctrl+C is a
        character here — no line input is left to take it — but a console that is going away fails
        instead, and that is the end of the input."""
        try:
            ch = msvcrt.getwch()
        except (KeyboardInterrupt, OSError):
            return None
        return None if ch == WEOF else ch


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


def serve(source: _Input) -> int:
    _say('FAKE-AGENT READY')
    _write(PROMPT)
    line = bytearray()
    while True:
        # One keystroke at a time, from the terminal (a ConPTY one included); nothing at all is
        # the terminal going away.
        byte = source.read_key()
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
    source: _Input = _RawConsole() if IS_WINDOWS else _Cbreak(sys.stdin.fileno())
    with source:
        return serve(source)


if __name__ == '__main__':
    sys.exit(main())