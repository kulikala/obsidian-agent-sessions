# How the README is written

The README is read before someone has the plugin, while they install it, and when something goes wrong. This page sets out the aims the writing follows and how a change is written and reviewed. It is a set of aims, not a checklist: where it says nothing, decide by what helps the person reading.

## Who reads it

- **Someone deciding whether to try it**, from Obsidian's plugin list or GitHub, in a few seconds.
- **Someone installing it**, who needs the requirements before the steps.
- **Someone stuck**, who arrives with the words they saw on screen. A plugin message that says "see the README" has its answer there.
- **Someone cautious**, who wants to know everything the plugin touches and how to undo it.
- **A contributor**, who needs one link to the developer docs.

## Aims

**Say plainly what the reader gets.** The opening says what the plugin is, who it is for and what it does for them, with a picture of it working. Every claim is one the reader can check. Nothing sells and nothing alarms.

**Write for someone reading it for the first time.** Each sentence makes sense to a reader who has not seen the code, the discussions or the earlier versions. Name the thing instead of pointing back at it. A sentence that needs the writer beside it to explain it gets rewritten.

**Say each thing once, where the reader looks for it.** What gets installed and how to remove it are in `What Install does`, `Uninstall` and the disclosures. The opening does not repeat them. Every feature is in `docs/usage.md`, so the README shows the main ones and links to the rest.

**Be complete where the reader has to trust it.** The disclosures name every network connection, program started, file read and file written, with real paths and what is sent where. Obsidian's plugin guidelines require them in the README, and here completeness matters more than length.

**Give the Python range the tests cover.** Requirements names the oldest and the newest Python the plugin is tested on. The oldest is `MIN_PYTHON` in `plugin/src/backend/bundle.ts`. A version counts as tested when CI runs the Python suite on it (`python-version` in `.github/workflows/test.yml`) or a smoke run for the release records it (the Environment block of the results, [testing.md](testing.md#reading-the-results)). Write "or later" only when the newest Python release is tested. A change in the range, and a newer Python that is not tested yet, go in the release notes of the version that brings them, not in the README: the README is edited rarely, and a note about one version goes stale once that version is supported. The evidence stays in CI and in the smoke results.

When the range changes, search the repository for the old versions and change every place that states the supported range, including `README.ja.md`, `docs/installation.md`, `docs/requirements.md` (R-P1), `docs/principles.md`, `docs/testing.md` and `agentsessions/skills/agent-sessions-help/reference.md`.

**State what is true now.** The README describes the current release. Dates, test runs, plans and the history of changes belong in commits.

**Keep what other pages depend on.** `docs/` and the plugin's messages link to headings in the README, so those anchors stay. `README.md` and `README.ja.md` have the same sections, pictures and links, which `tools/audit` checks.

## Japanese

`README.ja.md` is not a translation. Whenever a section changes, write its Japanese anew for a Japanese reader, from the same facts and in the same section, in sentences of its own. Use the plugin's Japanese UI names (`plugin/src/i18n/locales/ja.ts`) and the Japanese screenshots where they exist.

Then put the Japanese through [yomiyasu](https://github.com/nanaism/yomiyasu): its rewrite steps, its lint and its diff check. One point differs from yomiyasu: put a half-width space between Japanese and Latin letters or digits, as the plugin's Japanese UI does. `tools/audit` checks the spacing.

## Writing and reviewing a change

1. Write the English. Check every fact against the code, and the Python range in Requirements against CI's `python-version` and the Python the release's smoke runs recorded.
2. Write the Japanese anew and put it through yomiyasu.
3. Have each language reviewed by someone who did not write it and reads only the page. They read it from the top, once as each reader above, and report what does not make sense on its own, what is said twice, what a pointing word leaves unclear, and claims nothing backs. Fix what they report and have them read the change again until nothing is left.
4. Run `node tools/audit/run.mjs`.

## docs/usage.md

The README links here for every feature. Its readers already use the plugin and come to find how to do something, to understand what a screen shows, or to fix a problem. Its sections follow a new user's tasks in the order they meet them, and the headings name tasks and screens in the words the plugin's UI uses (`plugin/src/i18n/locales/en.ts`). It keeps every fact the plugin's behavior depends on. How the plugin was built belongs in `design.md`.
