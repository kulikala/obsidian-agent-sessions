# Third-party notices

`plugin/main.js` is built with esbuild and bundles the following dependencies from `plugin/package.json`. Each is distributed under the MIT License; the exact text and copyright line below are copied from the package's own `LICENSE` file (`plugin/node_modules/<package>/LICENSE`) as of the versions currently pinned in `plugin/package-lock.json`. No other runtime dependency is bundled — `plugin/package.json`'s `devDependencies` (esbuild, TypeScript, vitest, `obsidian`, `builtin-modules`, `@types/node`) are build/test-time only and are not included in `main.js`. The Python package `agentsessions/` uses only the Python standard library and has no third-party dependencies.

## @xterm/xterm 5.5.0

Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

## @xterm/addon-fit 0.10.0

Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)

## @xterm/addon-unicode11 0.8.0

Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)

## @xterm/addon-webgl 0.18.0

Copyright (c) 2018, The xterm.js authors (https://github.com/xtermjs/xterm.js)

## License text (MIT, applies to all four packages above)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
