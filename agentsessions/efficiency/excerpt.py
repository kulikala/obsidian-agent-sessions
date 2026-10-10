"""Masking, and reading conversation text back by byte offset, for the digest (`digest.py`).

Everything the digest (and Organize, through `json mask`) takes from a conversation goes through
`Masker`: secrets and private keys, e-mail addresses, the user info and everything after the host
of URLs (path, query, fragment), `user:password@` without a scheme, the server and share of
Windows network paths, and the home folder are replaced -- the home folder in every
form it takes (`/Users/<name>`, `/home/<name>`, `C:\\Users\\<name>` with either separator,
WSL's `/mnt/c/Users/<name>`, Claude Code's encoded `-Users-<name>-…` folder names), and the user
name alone between path separators; paths inside the vault become relative to it, paths in the
home folder start with `~`, other paths keep only their last two parts. These are patterns of
formats (keys, tokens, addresses, paths), not of words. `ClaudeTexts` reads a Claude Code
prompt, reply or command back from the line a file record points at.
"""

import getpass
import json
import os
import re
from typing import Dict, List, Optional

from ..sessions import detail
from . import normalize


_SECRET_RES = [
    re.compile(r'-----BEGIN[A-Z ]{0,40}PRIVATE KEY-----[^-]{0,20000}(?:-----END[A-Z ]{0,40}PRIVATE KEY-----)?'),
    re.compile(r'sk-ant-[A-Za-z0-9_\-]+'),
    re.compile(r'sk-[A-Za-z0-9_\-]{8,}'),
    re.compile(r'\b(?:[sprw]k_(?:live|test)|whsec)_[A-Za-z0-9]{8,}'),
    re.compile(r'\bgh[pousr]_[A-Za-z0-9]{8,}'),
    re.compile(r'github_pat_[A-Za-z0-9_]{8,}'),
    re.compile(r'\bglpat-[A-Za-z0-9_\-]{8,}'),
    re.compile(r'\bxox[abeoprs]-[A-Za-z0-9\-]+'),
    re.compile(r'\bxapp-[A-Za-z0-9\-]+'),
    re.compile(r'\b(?:AKIA|ASIA)[0-9A-Z]{16}'),
    re.compile(r'\bAIza[0-9A-Za-z_\-]{35}'),
    re.compile(r'\bya29\.[0-9A-Za-z_\-]{8,}'),
    re.compile(r'\b(?:hf|npm)_[A-Za-z0-9]{16,}'),
    re.compile(r'\bpypi-[A-Za-z0-9_\-]{16,}'),
    re.compile(r'\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}'),
    re.compile(r'eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+'),
    re.compile(r'(?:Bearer|Basic)\s+\S+'),
    re.compile(r'(?i)\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+'),
    re.compile(r'\b[0-9A-Fa-f]{32,}\b'),
    re.compile(r'(?<![A-Za-z0-9+/_\-])(?=[A-Za-z0-9+/_\-]*[0-9])(?=[A-Za-z0-9+/_\-]*[A-Za-z])'
               r'[A-Za-z0-9+/_\-]{32,}={0,2}'),
]
# scheme, user info (dropped), host, and whatever follows the host (path, query or fragment).
_URL_RE = re.compile(r'\b([a-zA-Z][a-zA-Z0-9+.\-]{0,31}://)([^\s/?#\'"<>()]{0,256}@)?'
                     r'([^\s/?#\'"<>()@]*)([/?#][^\s\'"<>()]*)?')
# `user:password@host` without a scheme.
_USERINFO_RE = re.compile(r'(?<![A-Za-z0-9._%+\-:/])[A-Za-z0-9._%+\-]{1,64}:[^\s@/\'"<>()]{1,128}@(?=[A-Za-z0-9\-])')
_EMAIL_RE = re.compile(r'(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9\-]{1,63}(?:\.[A-Za-z0-9\-]{1,63})+')
# A Windows network path: `\\server\share\…`.
_UNC_RE = re.compile(r'(?<![\\\w])\\\\[^\s\\/\'"`<>()|]+((?:\\[^\s\\\'"`<>()|]+)+)')
_PATH_RE = re.compile(r'(?<![\w.~\-/:])~?/(?:[^\s/\'"`<>()\[\]{},;|]+/)*[^\s/\'"`<>()\[\]{},;|]+'
                      r'|\b[A-Za-z]:\\(?:[^\s\\\'"`<>()|]+\\)*[^\s\\\'"`<>()|]*')
# How much of a text is masked when only its first `limit` characters are kept: masking shortens
# a text more than it lengthens it, so this margin leaves `limit` characters to keep.
_LIMIT_MARGIN = 4


def _url(m) -> str:
    return m.group(1) + ('[secret]@' if m.group(2) else '') + m.group(3) + ('/…' if m.group(4) else '')


def _unc(m) -> str:
    rest = [x for x in m.group(1).split('\\') if x]
    return '\\\\…' + ('\\' + rest[-1] if len(rest) > 1 else '')


def _head(text: str, n: int) -> str:
    """`text`'s first `n` characters, without the word cut in two at the end."""
    if len(text) <= n:
        return text
    head = text[:n]
    cut = max(head.rfind(c) for c in ' \t\r\n')
    return head[:cut] if cut > 0 else head


# Where a user's home folder can appear, before the user name: macOS, Linux, Windows (either
# separator, any drive), WSL's view of a Windows home, and Claude Code's encoded project folder
# names (`-Users-<name>-…`, `C--Users-<name>-…`).
_HOME_PREFIXES = (r'[A-Za-z]:[\\/]+Users[\\/]+', r'/mnt/[A-Za-z]/Users/', r'/Users/', r'/home/')
_ENCODED_PREFIX = r'(?:[A-Za-z]-)?-(?:Users|home)-'
# Characters that end a path component.
_END = r'(?=$|[\\/\s\'"`<>()\[\]{},;:|])'
# Shortest user name masked on its own between path separators.
MIN_USER_NAME = 3


def user_names(home: str) -> List[str]:
    """This machine's user names: the login name and the home folder's last part."""
    names = [os.path.basename(home.rstrip('/\\'))]
    try:
        names.append(getpass.getuser())
    except Exception:
        pass
    return sorted({n for n in names if n}, key=lambda n: (-len(n), n))


class Masker:
    """Masks strings before they are shown to a model (see the module docstring)."""

    def __init__(self, home: Optional[str] = None, vault: Optional[str] = None,
                 users: Optional[List[str]] = None):
        self.home = (home or os.path.expanduser('~')).rstrip('/\\')
        self.vault = vault.rstrip('/\\') if vault else None
        names = users if users is not None else user_names(self.home)
        alt = '|'.join(re.escape(n) for n in names)
        self._homes = re.compile(r'(?i)(?:%s)(?:%s)%s' % ('|'.join(_HOME_PREFIXES), alt, _END)) if alt else None
        self._encoded = re.compile(r'(?i)%s(?:%s)(?![A-Za-z0-9_])' % (_ENCODED_PREFIX, alt)) if alt else None
        self._names = {n.lower() for n in names if len(n) >= MIN_USER_NAME}
        long = '|'.join(re.escape(n) for n in names if len(n) >= MIN_USER_NAME)
        # A user name alone between separators (or after one, at the end of a path).
        self._alone = re.compile(r'(?i)(?:(?<=[\\/])(?:%s)%s|(?<![^\s\'"`<>()\[\]{},;:|])(?:%s)(?=[\\/]))'
                                 % (long, _END, long)) if long else None

    def users(self, text: str) -> str:
        """`text` with every home folder written out as `~` and a user name left alone between
        separators as `[user]`."""
        if self._homes:
            text = self._homes.sub('~', text)
        if self._encoded:
            text = self._encoded.sub('-~', text)
        if self._alone:
            text = self._alone.sub('[user]', text)
        return text

    def path(self, p: Optional[str]) -> Optional[str]:
        if not p:
            return p
        full = p
        if full == '~' or full.startswith('~/'):
            full = self.home + full[1:]
        win = '\\' in full and not full.startswith('/')
        sep = '\\' if win else '/'
        if self.vault and (full == self.vault or full.startswith(self.vault + sep)):
            rel = full[len(self.vault):].lstrip(sep)
            return self.users(rel.replace('\\', '/') or '.')
        if full == self.home:
            return '~'
        parts = [x for x in full.split(sep) if x]
        if full.startswith(self.home + sep):
            rest = [x for x in full[len(self.home):].split(sep) if x]
            if len(rest) <= 2:
                return self.users('~/' + '/'.join(rest))
        elif len(parts) <= 2:
            return self.users(full)
        return self.users('…/' + '/'.join(parts[-2:]))

    def folder(self, cwd: Optional[str]) -> Optional[str]:
        """A session's folder as it is shown to a model: relative inside the vault, its name
        alone outside (`~` for the home folder itself)."""
        if not cwd:
            return cwd
        if self.vault and (cwd == self.vault or cwd.startswith(self.vault + os.sep)):
            return self.users(os.path.relpath(cwd, self.vault).replace(os.sep, '/'))
        if cwd.rstrip('/\\') == self.home:
            return '~'
        name = os.path.basename(cwd.rstrip('/\\'))
        return '[user]' if name.lower() in self._names else self.users(name)

    def __call__(self, text: Optional[str], limit: Optional[int] = None) -> str:
        """`text` masked; with `limit`, at most its first `limit` characters. A long text is cut
        (between words) before it is masked, and the masked text is cut again, so a secret split
        by the first cut is not in what is kept."""
        if not text:
            return ''
        if limit is not None:
            text = _head(text, limit * _LIMIT_MARGIN)
        for r in _SECRET_RES:
            text = r.sub('[secret]', text)
        text = _URL_RE.sub(_url, text)
        text = _USERINFO_RE.sub('[secret]@', text)
        text = _EMAIL_RE.sub('[email]', text)
        text = _UNC_RE.sub(_unc, text)
        # Home folders first, so a path in another system's form still reads as one.
        text = self.users(text)
        text = _PATH_RE.sub(lambda m: self.path(m.group(0)), text)
        if self.home:
            text = text.replace(self.home, '~')
        text = self.users(text)
        return text[:limit] if limit is not None else text


def read_line(path: str, off: Optional[int]) -> Optional[dict]:
    if off is None:
        return None
    try:
        with open(path, 'rb') as f:
            f.seek(off)
            line = f.readline()
        rec = json.loads(line)
    except (OSError, ValueError):
        return None
    return rec if isinstance(rec, dict) else None


def _prompt_text(rec: Optional[dict]) -> str:
    if not rec:
        return ''
    text, _tools = detail._texts_and_tools((rec.get('message') or {}).get('content'))
    return normalize.prompt_text(text)


def _reply_text(rec: Optional[dict]) -> str:
    if not rec:
        return ''
    text, _tools = detail._texts_and_tools((rec.get('message') or {}).get('content'))
    return text.strip()


class ClaudeTexts:
    """Reads a Claude Code session's prompt, reply and command text back by byte offset. The
    other agents have their own (`sources.py`), with the same three methods."""

    def prompt(self, session: dict, off) -> str:
        return _prompt_text(read_line(session['main']['path'], off))

    def reply(self, session: dict, off) -> str:
        return _reply_text(read_line(session['main']['path'], off))

    def command(self, session: dict, tool: dict) -> Optional[str]:
        return _command(session['main']['path'], tool)


def _command(path: str, tool: dict) -> Optional[str]:
    if tool['k'] != 'exec' or tool.get('off') is None:
        return None
    rec = read_line(path, tool['off'])
    for b in ((rec or {}).get('message') or {}).get('content') or []:
        if isinstance(b, dict) and b.get('type') == 'tool_use' and b.get('id') == tool.get('id'):
            cmd = (b.get('input') or {}).get('command')
            return cmd if isinstance(cmd, str) else None
    return None
