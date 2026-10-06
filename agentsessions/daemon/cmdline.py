"""The `cmd.exe /d /s /c` line that starts a batch file (an npm shim such as `claude.cmd`) under
ConPTY. Pure, so it is tested on every OS; `conpty.py` uses it on Windows.

`cmd.exe` parses that line twice — once for `/c`, once more for the batch file's own `%*` — so an
argument holding one of its metacharacters (a session name such as `R&D: 50%`) would otherwise run
as a command or expand as a variable. Such an argument is quoted the way the C runtime reads it back
and each metacharacter is escaped with `^` twice: the scheme cross-spawn uses for npm's shims, and
the one `plugin/src/backend/windows.ts`'s `cmdShimArgument` uses. A plain word stays as it is.
"""

import re
import subprocess
from typing import List

# Characters `cmd.exe` gives a meaning to, and space and tab, which end a word there.
_CMD_META = re.compile(r'([()\][%!^"`<>&|;, \t*?])')


def shim_argument(arg: str) -> str:
    """`arg` for a batch file's command line: unchanged when it holds nothing `cmd.exe` would act
    on, else quoted for the C runtime and every metacharacter escaped twice."""
    if arg and not _CMD_META.search(arg):
        return arg
    quoted = re.sub(r'(\\*)"', lambda m: m.group(1) * 2 + '\\"', arg)
    quoted = re.sub(r'(\\*)$', lambda m: m.group(1) * 2, quoted)
    quoted = '"%s"' % quoted
    return _CMD_META.sub(r'^\1', _CMD_META.sub(r'^\1', quoted))


def shim_line(argv: List[str]) -> str:
    """The text inside `cmd.exe /d /s /c "…"` that runs batch file `argv[0]` with `argv[1:]`."""
    return ' '.join([subprocess.list2cmdline(argv[:1])] + [shim_argument(a) for a in argv[1:]])
