# Development

How to build, test, shoot screenshots, add a language, audit before a push, and cut a release. The README keeps only the short version.

1. [Build and test](#build-and-test)
2. [Screenshots](#screenshots)
3. [Adding a language](#adding-a-language)
4. [Before pushing or releasing](#before-pushing-or-releasing)
5. [Release (maintainers)](#release-maintainers)
6. [Where the other documents are](#where-the-other-documents-are)


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

## Before pushing or releasing

Run the audit before every push to `main` and before tagging a release:

```sh
node tools/audit/run.mjs                 # the commits origin/main..HEAD, the working tree, the build and all suites
node tools/audit/run.mjs --skip-tests    # the static checks only
node tools/audit/run.mjs --range A..B    # another range of commits; --rev REV audits a commit's tree instead
```

It prints each failure with its place (`file:line`, or the commit) and how to fix it, and exits 1 if anything fails; warnings alone pass. What fails each check:

- **Privacy.** In the tree, and in every commit message and added line of the range: a home folder whose name is not a placeholder (`/Users/alex`, `/home/sam`; the list is in `config.json`), an email address other than the no-reply and `example.*` ones, any Gmail address, and the local user's names: the login name, the account's full name and git's `user.name`, read from the machine when the audit runs, plus `AUDIT_PRIVATE_NAMES` (comma-separated). The repository owner's handle passes inside the repository's own GitHub URLs. Author and committer addresses must be no-reply addresses.
- **Secrets.** Shapes of API keys, tokens and private keys. The masker's tests, which hold made-up ones, are exempt.
- **Commits.** Japanese or full-width characters in a message. A message with Claude trailers must end with the `Co-Authored-By:` line and then the `Claude-Session:` line.
- **Language.** Japanese outside the files that hold it: the Japanese locales, `README.ja.md`, the tests and the screenshot scenarios. Elsewhere it may appear quoted (`"…"`, `` `…` ``, 「…」) or in a Markdown code block, and in code only quoted inside a comment. Lines where the program itself matches or writes Japanese, and the language's own name, are listed in `config.json`.
- **i18n.** `en.ts`/`ja.ts` and `en.py`/`ja.py` with different keys or placeholders (a plural-only placeholder such as `{count|token|tokens}` may be left out of Japanese), Japanese in an English string, and in Japanese strings and `README.ja.md` no half-width space between Japanese and Latin letters. A digit may touch a counter or unit (`5時間`, `最大30件`); other digit contacts are warnings.
- **Denylist.** The words in `tools/audit/denylist.json` in what users read (the locales, the READMEs, `usage.md`, `installation.md`, the agent skills), with the word to use instead.
- **Versions.** The two manifests differ; `package.json`, `package-lock.json` or `versions.json` disagree with the manifest's version; `minAppVersion` is missing; a what's-new entry is newer than the version.
- **Docs.** A relative link, anchor or picture in the READMEs, `docs/*.md` or a tool's README that does not resolve; `README.md` and `README.ja.md` with different sections, pictures or links ([`readme-guide.md`](readme-guide.md)).
- **Hygiene.** `console.log`/`debug`/`trace` or `debugger` in `plugin/src`, `.only(` in a test, a file over 1 MB outside `docs/images` and `docs/onboarding`.
- **Build.** `esbuild` (into a scratch file, never `plugin/main.js`), `tsc`, `vitest` and the Python suite. Needs `npm ci` in `plugin/` first.

The lists the checks use, and why each entry is there, are in `tools/audit/config.json`. A finding in a commit that is already written and stays as it is goes into `tools/audit/accepted.json` (`commit`, `checks`, `why`); it is then reported as a warning.

To run the audit on every `git push`, link the hook once per clone, from the repository root:

```sh
ln -s ../../tools/audit/pre-push "$(git rev-parse --git-common-dir)/hooks/pre-push"
```

It audits the commits each push sends (a new branch: those not on `origin/main`). `AUDIT_SKIP_TESTS=1 git push` leaves out the build and suites; `git push --no-verify` skips the hook.

CI runs the static checks on every push and pull request (the `audit` job in `.github/workflows/test.yml`), on the commits that push or pull request brings.

## Release (maintainers)

Run the audit first ([Before pushing or releasing](#before-pushing-or-releasing)), then:

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
- [`readme-guide.md`](readme-guide.md): who the README is for, and how to review a change to it.
- [`../tools/screenshots/README.md`](../tools/screenshots/README.md): the screenshot tool.
