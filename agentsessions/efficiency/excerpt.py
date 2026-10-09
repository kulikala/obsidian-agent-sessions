"""Masking, and reading conversation text back by byte offset, for the digest (`digest.py`).

Everything the digest takes from a conversation goes through `Masker`: secrets, e-mail
addresses, the path part of URLs, and the home folder are replaced -- the home folder in every
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
    re.compile(r'sk-ant-[A-Za-z0-9_\-]+'),
    re.compile(r'sk-[A-Za-z0-9_\-]{8,}'),
    re.compile(r'gh[po]_[A-Za-z0-9]{8,}'),
    re.compile(r'github_pat_[A-Za-z0-9_]{8,}'),
    re.compile(r'xox[bp]-[A-Za-z0-9\-]+'),
    re.compile(r'AKIA[0-9A-Z]{16}'),
    re.compile(r'eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+'),
    re.compile(r'Bearer\s+\S+'),
    re.compile(r'(?i)\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+'),
    re.compile(r'\b[0-9A-Fa-f]{32,}\b'),
    re.compile(r'(?<![A-Za-z0-9+/_\-])(?=[A-Za-z0-9+/_\-]*[0-9])(?=[A-Za-z0-9+/_\-]*[A-Za-z])'
               r'[A-Za-z0-9+/_\-]{32,}={0,2}'),
]
_URL_RE = re.compile(r'\b([a-zA-Z][a-zA-Z0-9+.\-]*://)([^\s/\'"<>()]+)(/[^\s\'"<>()]*)?')
_EMAIL_RE = re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+')
_PATH_RE = re.compile(r'(?<![\w.~\-/:])~?/(?:[^\s/\'"`<>()\[\]{},;|]+/)*[^\s/\'"`<>()\[\]{},;|]+'
                      r'|\b[A-Za-z]:\\(?:[^\s\\\'"`<>()|]+\\)*[^\s\\\'"`<>()|]*')


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

    def __call__(self, text: Optional[str]) -> str:
        if not text:
            return ''
        for r in _SECRET_RES:
            text = r.sub('[secret]', text)
        text = _URL_RE.sub(lambda m: m.group(1) + m.group(2) + ('/…' if m.group(3) else ''), text)
        text = _EMAIL_RE.sub('[email]', text)
        # Home folders first, so a path in another system's form still reads as one.
        text = self.users(text)
        text = _PATH_RE.sub(lambda m: self.path(m.group(0)), text)
        if self.home:
            text = text.replace(self.home, '~')
        return self.users(text)


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
