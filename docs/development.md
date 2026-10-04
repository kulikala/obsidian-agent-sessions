# Development

How to build, test, shoot screenshots, add a language, and cut a release. The README keeps only the short version.

1. [Build and test](#build-and-test)
2. [Screenshots](#screenshots)
3. [Adding a language](#adding-a-language)
4. [Release (maintainers)](#release-maintainers)
5. [Where the other documents are](#where-the-other-documents-are)


## Build and test

```sh
cd plugin && npm install
npm test && npm run typecheck && npm run build   # plugin (vitest, tsc, esbuild)
AGENT_SESSIONS_BIN=$PWD/../bin/agent-sessions npm test   # also run the tests that exercise a real daemon

cd ..
python3 -W error -m unittest discover -s tests -t .   # Python (standard library only)
```

Beyond the unit tests, a smoke test drives the daemon, CLI and hooks inside a running Obsidian with a fake agent on a virtual machine per supported OS (`tools/smoke`), and a short UI checklist is run by hand before a release. How to run each, and the extra checks for WSLg, is in [`testing.md`](testing.md). The reasoning behind the design choices, including the platform scope, is in [`principles.md`](principles.md).

## Screenshots

The images in the README are generated: `node tools/screenshots/shoot.mjs` (after `npm run build`) runs the built plugin in a separate, sandboxed Obsidian against made-up sessions and writes `docs/images/`. See [`tools/screenshots/README.md`](../tools/screenshots/README.md).

## Adding a language

Add `plugin/src/i18n/locales/<code>.ts` (a `Partial<Record<MessageKey, string>>` plus a `<CODE>_SELF_NAME` autonym — see `locales/ja.ts`) and `agentsessions/i18n/locales/<code>.py` (a `MESSAGES` dict — see `locales/ja.py`), then register each one, one line apiece, in `i18n/index.ts`'s `LOCALES` and `i18n/__init__.py`'s `_TABLES`. A locale can start out partial; a key it hasn't filled in yet falls back to English on both sides. See [`design.md`](design.md#17-i18n).

## Release (maintainers)

```sh
cd plugin && npm version minor --no-git-tag-version   # or patch / major; updates plugin/package.json, plugin/manifest.json, the root manifest.json, and versions.json
cd .. && git commit -am "Release X.Y.Z"
git tag -a X.Y.Z -m "Agent Sessions X.Y.Z"   # the bare version, no "v" prefix: it must equal manifest.json's version
git push origin main X.Y.Z
```

`npm version` runs inside `plugin/`, which is not the repository root, so it updates the files but does not commit or tag; the commit and tag are made by hand as above.

Pushing the tag runs `.github/workflows/release.yml`, which builds the plugin and attaches `main.js`, `manifest.json`, and `styles.css` to a draft GitHub Release. Review the draft, then publish it.

## Where the other documents are

- [`principles.md`](principles.md): the design principles and the platform scope.
- [`design.md`](design.md): the full design.
- [`architecture.md`](architecture.md): the architecture.
- [`requirements.md`](requirements.md): the requirements the plugin is built against.
- [`testing.md`](testing.md): automated tests, the smoke test, and the UI checklist.
- [`../tools/screenshots/README.md`](../tools/screenshots/README.md): the screenshot tool.
