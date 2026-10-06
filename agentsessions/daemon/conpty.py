"""A process under a Windows pseudo console (ConPTY), through `ctypes` (standard library only).

Windows' `select` only takes sockets, so the daemon's loop can't wait on the pseudo console's
pipes directly. Each `ConPty` therefore runs three small threads and exposes a socket instead:

- a reader copies the console's output pipe into one end of a `socket.socketpair()`; the daemon
  selects on the other end (`fileno()`), exactly as it selects on a PTY master on Unix. EOF on the
  output pipe closes the pair, which the loop sees as EOF.
- a writer drains a queue into the input pipe (`WriteFile` blocks when the child isn't reading;
  the loop must not).
- a waiter waits for the process, records its exit code and closes the pseudo console, which is
  what ends the output pipe (it stays open for as long as the console exists).

`poll()` reports the exit code only once the output has been fully drained into the pair, so the
daemon never loses the last screen to a race between the exit and the reader.

The child and every process it starts run in a job object that kills them all when the job handle
closes — the counterpart of the SIGHUP a Unix PTY's children get when the daemon goes away.

The child must not inherit this process's own standard handles (`STARTF_USESTDHANDLES` with null
handles): when the daemon's stdout is a pipe, a console child would otherwise write there instead
of into the pseudo console.
"""

import ctypes
import ctypes.wintypes as w
import os
import queue
import shutil
import socket
import subprocess
import threading
from typing import Dict, List, Optional

from . import cmdline

_k32 = ctypes.WinDLL('kernel32', use_last_error=True)  # type: ignore[attr-defined]

HPCON = w.HANDLE
INFINITE = 0xFFFFFFFF
STILL_ACTIVE = 259
PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
CREATE_SUSPENDED = 0x00000004
STARTF_USESTDHANDLES = 0x00000100
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
READ_SIZE = 64 * 1024


class _COORD(ctypes.Structure):
    _fields_ = [('X', w.SHORT), ('Y', w.SHORT)]


class _STARTUPINFOW(ctypes.Structure):
    _fields_ = [('cb', w.DWORD), ('lpReserved', w.LPWSTR), ('lpDesktop', w.LPWSTR), ('lpTitle', w.LPWSTR),
                ('dwX', w.DWORD), ('dwY', w.DWORD), ('dwXSize', w.DWORD), ('dwYSize', w.DWORD),
                ('dwXCountChars', w.DWORD), ('dwYCountChars', w.DWORD), ('dwFillAttribute', w.DWORD),
                ('dwFlags', w.DWORD), ('wShowWindow', w.WORD), ('cbReserved2', w.WORD),
                ('lpReserved2', ctypes.c_void_p), ('hStdInput', w.HANDLE), ('hStdOutput', w.HANDLE),
                ('hStdError', w.HANDLE)]


class _STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [('StartupInfo', _STARTUPINFOW), ('lpAttributeList', ctypes.c_void_p)]


class _PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [('hProcess', w.HANDLE), ('hThread', w.HANDLE), ('dwProcessId', w.DWORD),
                ('dwThreadId', w.DWORD)]


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in ('ReadOperationCount', 'WriteOperationCount',
                                                  'OtherOperationCount', 'ReadTransferCount',
                                                  'WriteTransferCount', 'OtherTransferCount')]


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong),
                ('LimitFlags', w.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', w.DWORD),
                ('Affinity', ctypes.c_size_t), ('PriorityClass', w.DWORD), ('SchedulingClass', w.DWORD)]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [('BasicLimitInformation', _JOBOBJECT_BASIC_LIMIT_INFORMATION), ('IoInfo', _IO_COUNTERS),
                ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]


def _sig(fn, argtypes, restype=w.BOOL):
    fn.argtypes = argtypes
    fn.restype = restype
    return fn


_CreatePseudoConsole = _sig(_k32.CreatePseudoConsole,
                            [_COORD, w.HANDLE, w.HANDLE, w.DWORD, ctypes.POINTER(HPCON)], ctypes.c_long)
_ResizePseudoConsole = _sig(_k32.ResizePseudoConsole, [HPCON, _COORD], ctypes.c_long)
_ClosePseudoConsole = _sig(_k32.ClosePseudoConsole, [HPCON], None)
_CreatePipe = _sig(_k32.CreatePipe, [ctypes.POINTER(w.HANDLE), ctypes.POINTER(w.HANDLE), ctypes.c_void_p, w.DWORD])
_InitializeProcThreadAttributeList = _sig(_k32.InitializeProcThreadAttributeList,
                                          [ctypes.c_void_p, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)])
_UpdateProcThreadAttribute = _sig(_k32.UpdateProcThreadAttribute,
                                  [ctypes.c_void_p, w.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t,
                                   ctypes.c_void_p, ctypes.c_void_p])
_DeleteProcThreadAttributeList = _sig(_k32.DeleteProcThreadAttributeList, [ctypes.c_void_p], None)
_CreateProcessW = _sig(_k32.CreateProcessW,
                       [w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD, ctypes.c_void_p,
                        w.LPCWSTR, ctypes.POINTER(_STARTUPINFOEXW), ctypes.POINTER(_PROCESS_INFORMATION)])
_ReadFile = _sig(_k32.ReadFile, [w.HANDLE, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.c_void_p])
_WriteFile = _sig(_k32.WriteFile, [w.HANDLE, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.c_void_p])
_WaitForSingleObject = _sig(_k32.WaitForSingleObject, [w.HANDLE, w.DWORD], w.DWORD)
_GetExitCodeProcess = _sig(_k32.GetExitCodeProcess, [w.HANDLE, ctypes.POINTER(w.DWORD)])
_CloseHandle = _sig(_k32.CloseHandle, [w.HANDLE])
_ResumeThread = _sig(_k32.ResumeThread, [w.HANDLE], w.DWORD)
_TerminateProcess = _sig(_k32.TerminateProcess, [w.HANDLE, w.UINT])
_CreateJobObjectW = _sig(_k32.CreateJobObjectW, [ctypes.c_void_p, w.LPCWSTR], w.HANDLE)
_SetInformationJobObject = _sig(_k32.SetInformationJobObject, [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD])
_AssignProcessToJobObject = _sig(_k32.AssignProcessToJobObject, [w.HANDLE, w.HANDLE])
_TerminateJobObject = _sig(_k32.TerminateJobObject, [w.HANDLE, w.UINT])


def _winerror(what: str) -> OSError:
    code = ctypes.get_last_error()
    return OSError(code, '%s failed: %s' % (what, ctypes.FormatError(code).strip()))  # type: ignore[attr-defined]


def _env_block(env: Dict[str, str]) -> ctypes.Array:
    # Sorted case-insensitively, as CreateProcess expects; `NAME=value\0...\0\0`.
    items = sorted(env.items(), key=lambda kv: kv[0].upper())
    text = ''.join('%s=%s\0' % (k, v) for k, v in items if k and '=' not in k[1:]) + '\0'
    return ctypes.create_unicode_buffer(text, len(text))


def resolve_command(argv: List[str], env: Dict[str, str]) -> List[str]:
    """`argv` with `argv[0]` resolved against the child's own `PATH`/`PATHEXT` (what `execvpe`
    does on Unix). A `.cmd`/`.bat` script runs through `cmd.exe /d /s /c` — CreateProcess can't
    start one directly; its arguments are escaped for `cmd.exe` (`cmdline.shim_line`)."""
    path = env.get('PATH') or env.get('Path') or os.environ.get('PATH', '')
    found = shutil.which(argv[0], path=path) or argv[0]
    if found.lower().endswith(('.cmd', '.bat')):
        comspec = env.get('ComSpec') or env.get('COMSPEC') or os.environ.get('ComSpec') or 'cmd.exe'
        return [comspec, '/d', '/s', '/c', cmdline.shim_line([found] + argv[1:])]
    return [found] + argv[1:]


def command_line(argv: List[str]) -> str:
    if len(argv) == 5 and argv[1:4] == ['/d', '/s', '/c']:
        # cmd.exe's /s /c strips exactly one pair of outer quotes from the rest of the line.
        return '%s /d /s /c "%s"' % (subprocess.list2cmdline([argv[0]]), argv[4])
    return subprocess.list2cmdline(argv)


class ConPty:
    """One child process on its own pseudo console. Not thread-safe beyond what's documented:
    `read`/`write`/`set_size`/`terminate`/`kill`/`poll`/`close` are called from the daemon's
    loop only."""

    def __init__(self, argv: List[str], env: Dict[str, str], cwd: str, cols: int, rows: int) -> None:
        self._exit: Optional[int] = None
        self._drained = threading.Event()
        self._closed = False
        self._lock = threading.Lock()
        self._writes: 'queue.Queue[Optional[bytes]]' = queue.Queue()
        self._hpc = HPCON()
        self._job = None
        in_r, in_w, out_r, out_w = w.HANDLE(), w.HANDLE(), w.HANDLE(), w.HANDLE()
        if not _CreatePipe(ctypes.byref(in_r), ctypes.byref(in_w), None, 0):
            raise _winerror('CreatePipe')
        if not _CreatePipe(ctypes.byref(out_r), ctypes.byref(out_w), None, 0):
            _CloseHandle(in_r)
            _CloseHandle(in_w)
            raise _winerror('CreatePipe')
        hr = _CreatePseudoConsole(_COORD(cols, rows), in_r, out_w, 0, ctypes.byref(self._hpc))
        # The console holds its own references to its ends of the pipes.
        _CloseHandle(in_r)
        _CloseHandle(out_w)
        if hr != 0:
            _CloseHandle(in_w)
            _CloseHandle(out_r)
            raise OSError('CreatePseudoConsole failed: 0x%08x' % (hr & 0xFFFFFFFF))
        self._in_w = in_w
        self._out_r = out_r
        try:
            self.pid, self._hprocess = self._spawn(argv, env, cwd)
        except BaseException:
            _ClosePseudoConsole(self._hpc)
            _CloseHandle(in_w)
            _CloseHandle(out_r)
            raise
        self._sock, self._peer = socket.socketpair()
        self._sock.setblocking(False)
        for target in (self._reader, self._writer, self._waiter):
            threading.Thread(target=target, name='conpty-%d' % self.pid, daemon=True).start()

    def _spawn(self, argv: List[str], env: Dict[str, str], cwd: str):
        size = ctypes.c_size_t()
        _InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        attrs = (ctypes.c_byte * size.value)()
        if not _InitializeProcThreadAttributeList(attrs, 1, 0, ctypes.byref(size)):
            raise _winerror('InitializeProcThreadAttributeList')
        try:
            if not _UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, self._hpc,
                                              ctypes.sizeof(self._hpc), None, None):
                raise _winerror('UpdateProcThreadAttribute')
            si = _STARTUPINFOEXW()
            si.StartupInfo.cb = ctypes.sizeof(_STARTUPINFOEXW)
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES
            si.lpAttributeList = ctypes.cast(attrs, ctypes.c_void_p)
            pi = _PROCESS_INFORMATION()
            resolved = resolve_command(argv, env)
            cmdline = ctypes.create_unicode_buffer(command_line(resolved))
            block = _env_block(env)
            flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED
            if not _CreateProcessW(None, cmdline, None, None, False, flags, block, cwd or None,
                                   ctypes.byref(si), ctypes.byref(pi)):
                raise _winerror('CreateProcess %r' % resolved[0])
        finally:
            _DeleteProcThreadAttributeList(attrs)
        self._job = self._make_job(pi.hProcess)
        _ResumeThread(pi.hThread)
        _CloseHandle(pi.hThread)
        return int(pi.dwProcessId), pi.hProcess

    @staticmethod
    def _make_job(hprocess):
        job = _CreateJobObjectW(None, None)
        if not job:
            return None
        info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = _SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, ctypes.byref(info),
                                      ctypes.sizeof(info))
        if not ok or not _AssignProcessToJobObject(job, hprocess):
            # Without a job (e.g. a restrictive parent job), the child still runs; only the
            # whole-tree kill on the daemon's exit is lost.
            _CloseHandle(job)
            return None
        return job

    # ---- threads -------------------------------------------------------------

    def _reader(self) -> None:
        buf = ctypes.create_string_buffer(READ_SIZE)
        n = w.DWORD()
        try:
            while _ReadFile(self._out_r, buf, READ_SIZE, ctypes.byref(n), None) and n.value:
                try:
                    self._peer.sendall(buf.raw[:n.value])
                except OSError:
                    break
        finally:
            _CloseHandle(self._out_r)
            self._drained.set()
            try:
                self._peer.shutdown(socket.SHUT_WR)
            except OSError:
                pass
            self._peer.close()

    def _writer(self) -> None:
        n = w.DWORD()
        while True:
            data = self._writes.get()
            if data is None:
                break
            view = memoryview(data)
            while view:
                if not _WriteFile(self._in_w, bytes(view), len(view), ctypes.byref(n), None) or not n.value:
                    view = memoryview(b'')
                    break
                view = view[n.value:]
        _CloseHandle(self._in_w)

    def _waiter(self) -> None:
        _WaitForSingleObject(self._hprocess, INFINITE)
        code = w.DWORD()
        _GetExitCodeProcess(self._hprocess, ctypes.byref(code))
        with self._lock:
            self._exit = int(code.value)
        self._close_console()

    def _close_console(self) -> None:
        with self._lock:
            hpc, self._hpc = self._hpc, None
        if hpc:
            _ClosePseudoConsole(hpc)

    # ---- the daemon loop's side ---------------------------------------------------

    def fileno(self) -> int:
        return self._sock.fileno()

    def read(self, size: int) -> bytes:
        """Raises `BlockingIOError` when nothing is waiting; `b''` at EOF."""
        return self._sock.recv(size)

    def write(self, data: bytes) -> int:
        if data:
            self._writes.put(bytes(data))
        return len(data)

    def set_size(self, cols: int, rows: int) -> None:
        with self._lock:
            hpc = self._hpc
        if hpc:
            _ResizePseudoConsole(hpc, _COORD(cols, rows))

    def terminate(self) -> None:
        """The gentle stop: closing the pseudo console sends CTRL_CLOSE_EVENT to the console's
        processes, as closing a terminal window would."""
        self._close_console()

    def kill(self) -> None:
        if self._job:
            _TerminateJobObject(self._job, 1)
        else:
            _TerminateProcess(self._hprocess, 1)

    def poll(self) -> Optional[int]:
        """The exit code once the process has exited AND its output is fully drained; else None."""
        with self._lock:
            code = self._exit
        if code is None or not self._drained.wait(0):
            return None
        return code

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._writes.put(None)
        try:
            self._sock.close()
        except OSError:
            pass

    def release(self) -> None:
        """Frees the process and job handles (after exit). Closing the job kills anything the
        child left running."""
        self.close()
        if self._job:
            _CloseHandle(self._job)
            self._job = None
        if self._hprocess:
            _CloseHandle(self._hprocess)
            self._hprocess = None
