"""Comparing folder paths the way the platform does.

An agent records the folder it ran in (Codex's `session_meta.cwd`, OpenCode's
`session.directory`) in its own spelling, and the plugin passes the folder it started
the session in. On Unix both are the same string. On Windows the same folder can be
spelled `C:\\Users\\me\\vault`, `c:\\users\\me\\vault\\`, `C:/Users/me/vault` or
`\\\\?\\C:\\Users\\me\\vault`, and Windows treats them all as one folder.

`sqlite_uri` is the `file:` URI SQLite opens a database path by, with a drive letter on Windows.
`without_spaces` names a Windows file through its folder's 8.3 form.
"""
import ntpath
import sys
from typing import Optional
from urllib.parse import quote

IS_WINDOWS = sys.platform == 'win32'

_VERBATIM = '\\\\?\\'
_VERBATIM_UNC = '\\\\?\\UNC\\'


def folder_key(path: str, windows: Optional[bool] = None) -> str:
    """`path` reduced to what identifies the folder on this platform: unchanged on Unix; on
    Windows without a `\\\\?\\` prefix, with backslashes, without a trailing separator, and
    case-folded."""
    if windows is None:
        windows = IS_WINDOWS
    if not windows or not path:
        return path
    p = path.replace('/', '\\')
    if p.upper().startswith(_VERBATIM_UNC):
        p = '\\\\' + p[len(_VERBATIM_UNC):]
    elif p.startswith(_VERBATIM):
        p = p[len(_VERBATIM):]
    p = ntpath.normpath(p)
    if len(p) > 3 or not p.endswith('\\'):
        p = p.rstrip('\\')
    return ntpath.normcase(p)


def same_folder(a: str, b: str, windows: Optional[bool] = None) -> bool:
    """Whether `a` and `b` name the same folder (see `folder_key`)."""
    return folder_key(a, windows) == folder_key(b, windows)


def sqlite_uri(path: str, query: str, windows: Optional[bool] = None) -> str:
    """`file:<path>?<query>` for `sqlite3.connect(..., uri=True)`: the path percent-encoded (a
    `?`, `#` or `%` in it would otherwise end or garble it) and, on Windows, with forward slashes
    and a `/` before the drive letter (`file:/C:/Users/...`), the form SQLite documents there."""
    p = path
    if windows if windows is not None else IS_WINDOWS:
        p = p.replace('\\', '/')
        if not p.startswith('/'):
            p = '/' + p
    return 'file:%s?%s' % (quote(p, safe='/:'), query)


def short_path(path: str) -> str:
    """`path`'s 8.3 form on Windows (`GetShortPathNameW`), or `path` itself when there is none or
    elsewhere."""
    if not IS_WINDOWS:
        return path
    import ctypes
    buf = ctypes.create_unicode_buffer(32768)
    if ctypes.windll.kernel32.GetShortPathNameW(path, buf, len(buf)):  # type: ignore[attr-defined]
        return buf.value
    return path


def without_spaces(path: str, short=None) -> str:
    """`path` with its folder named by its 8.3 form when that folder has a space, keeping the base
    name (the built-in editor's shim: OpenCode splits `VISUAL` at every space, Codex at unquoted
    ones, and Claude Code looks for "code" in the base name). `short` maps a folder to its 8.3 form
    (`GetShortPathNameW` by default); a form that still has a space is not used."""
    folder, name = ntpath.split(path)
    if ' ' not in folder:
        return path
    shorter = (short or short_path)(folder)
    return path if ' ' in shorter else ntpath.join(shorter, name)
