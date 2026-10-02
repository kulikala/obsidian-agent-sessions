"""Process checks that work on every platform: is a pid alive, and which processes are running.

On Unix these are `os.kill(pid, 0)` and `ps`. On Windows `os.kill(pid, 0)` would *terminate* the
process (any signal other than CTRL_C_EVENT/CTRL_BREAK_EVENT maps to TerminateProcess), so it must
never be used there: `pid_alive` opens the process for a query instead, and `process_table` reads a
Toolhelp snapshot (executable names only — Windows doesn't hand out other processes' command lines
without much more privilege).
"""

import os
import shutil
import subprocess
import sys
from typing import Dict, Optional

IS_WINDOWS = sys.platform == 'win32'

if IS_WINDOWS:
    import ctypes
    import ctypes.wintypes as w

    _k32 = ctypes.WinDLL('kernel32', use_last_error=True)  # type: ignore[attr-defined]
    _PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    _STILL_ACTIVE = 259
    _ERROR_ACCESS_DENIED = 5
    _TH32CS_SNAPPROCESS = 0x2
    _INVALID_HANDLE = ctypes.c_void_p(-1).value

    class _PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [('dwSize', w.DWORD), ('cntUsage', w.DWORD), ('th32ProcessID', w.DWORD),
                    ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', w.DWORD),
                    ('cntThreads', w.DWORD), ('th32ParentProcessID', w.DWORD),
                    ('pcPriClassBase', ctypes.c_long), ('dwFlags', w.DWORD),
                    ('szExeFile', w.WCHAR * 260)]

    _k32.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    _k32.OpenProcess.restype = w.HANDLE
    _k32.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
    _k32.CloseHandle.argtypes = [w.HANDLE]
    _k32.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
    _k32.CreateToolhelp32Snapshot.restype = w.HANDLE
    _k32.Process32FirstW.argtypes = [w.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
    _k32.Process32NextW.argtypes = [w.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]


def pid_alive(pid: int) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    if IS_WINDOWS:
        h = _k32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return ctypes.get_last_error() == _ERROR_ACCESS_DENIED
        try:
            code = w.DWORD()
            if not _k32.GetExitCodeProcess(h, ctypes.byref(code)):
                return True
            return code.value == _STILL_ACTIVE
        finally:
            _k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def process_table(fmt: str = 'args') -> Optional[Dict[int, str]]:
    """`{pid: text}` for every process, or `None` if it can't be read. `fmt` is the `ps` column
    (`args`, `comm`); on Windows the text is always the executable's file name."""
    if IS_WINDOWS:
        return _windows_table()
    ps = shutil.which('ps') or 'ps'
    try:
        out = subprocess.run([ps, '-eo', 'pid=,%s=' % fmt], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=5).stdout.decode('utf-8', 'replace')
    except (OSError, subprocess.SubprocessError):
        return None
    table: Dict[int, str] = {}
    for line in out.splitlines():
        pid, _, text = line.strip().partition(' ')
        if pid.isdigit():
            table[int(pid)] = text.strip()
    return table


def parent_table() -> Optional[Dict[int, int]]:
    """`{pid: ppid}` for every process, or `None` if it can't be read."""
    if IS_WINDOWS:
        return _windows_snapshot(parents=True)  # type: ignore[return-value]
    ps = shutil.which('ps') or 'ps'
    try:
        out = subprocess.run([ps, '-eo', 'pid=,ppid='], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=5).stdout.decode('utf-8', 'replace')
    except (OSError, subprocess.SubprocessError):
        return None
    table: Dict[int, int] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            table[int(parts[0])] = int(parts[1])
    return table


def _windows_table() -> Optional[Dict[int, str]]:
    return _windows_snapshot(parents=False)  # type: ignore[return-value]


def _windows_snapshot(parents: bool):
    snap = _k32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
    if not snap or snap == _INVALID_HANDLE:
        return None
    try:
        entry = _PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
        table = {}
        ok = _k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            pid = int(entry.th32ProcessID)
            table[pid] = int(entry.th32ParentProcessID) if parents else entry.szExeFile
            ok = _k32.Process32NextW(snap, ctypes.byref(entry))
        return table
    finally:
        _k32.CloseHandle(snap)
