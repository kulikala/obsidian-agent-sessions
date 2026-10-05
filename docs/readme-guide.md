# How the README is written

The README is the page people read before they have the plugin, while they install it, and when something goes wrong. This page says who reads it, what each of them needs from it, and what follows for the writing. Use it when you change the README.

## Readers and what each needs

| Reader | Arrives from | Needs to | Time |
|---|---|---|---|
| Browser | Obsidian's plugin list, GitHub | decide whether to try it | seconds |
| Installer | the plugin list, the README | reach a first session | minutes |
| Stuck user | a problem in use | find the symptom and the fix | a minute |
| Cautious user | before or after installing | know what it touches and how to undo it | a few minutes |
| Contributor | GitHub | find build, test and design docs | seconds |

- **Browser.** Learns what the plugin is, what they get from it, and whether it fits their setup: desktop, operating system, agent.
- **Installer.** Finds the requirements before the steps, and the steps are few enough to follow without leaving the page.
- **Stuck user.** Recognizes their problem in the words they saw on screen. Every message in the plugin that says "see the README" has its answer there.
- **Cautious user.** Finds every network connection, program started, file read and file written, and the way to remove it all. Obsidian's plugin guidelines require these disclosures in the README.
- **Contributor.** Gets one link to the developer docs.

## What follows

Each point names the reader it serves.

- **The value comes first.** The first lines say what the plugin is and what it does for you, with a screenshot. (Browser)
- **Each feature is shown next to its picture.** A reader understands a feature faster by seeing it than by reading about it. Each feature gets a short heading, one or two sentences on what the reader gets, and the picture that shows it. The alt text says what the picture actually shows. A feature without a fitting picture keeps its heading and sentence; no picture is forced. `README.ja.md` uses the Japanese screenshots where they exist. (Browser)
- **Features are what the reader can do.** Not how they were built or tested. The full list lives in `docs/usage.md`. (Browser)
- **Limits that would stop an install are on the first screen.** Platform and agent support, so someone who cannot use it finds out before installing. (Browser)
- **Requirements, then supported setups, then install steps.** In that order, so nobody starts an install that cannot work. Details beyond the steps live in `docs/installation.md`. (Installer)
- **Troubleshooting starts with the symptom.** The bold part is what the user sees; the fix follows. Rare cases live in `docs/usage.md`. (Stuck user)
- **Disclosures are complete and concrete.** Real paths, real program names, what is sent where and when. Grouped by kind of access so a reader can check one kind at a time. (Cautious user)
- **Tables hold short values that are compared across rows.** A cell is a word, a path or a short phrase. Anything that needs a sentence goes in prose or a list outside the table. (Everyone scanning)
- **Facts are stated as they are now.** No test dates, machines, build numbers, task IDs, internal labels or history of changes; that belongs in commits. (Everyone: they need what is true today.)
- **Plain tone.** Say what it does and what it does not do. No superlatives, selling, warnings meant to worry, or explanations of the obvious. (Browser and cautious user: plain statements are easier to trust and check.)
- **Anchors other pages link to stay stable.** `docs/` and the plugin's messages point into the README. (Stuck user, Cautious user)
- **Developer material is a link.** Build, test, release and design go in `docs/`. (Contributor, and a shorter page for everyone else.)
- **Every sentence earns its place.** If removing it changes nothing a reader can decide or do, remove it. (Everyone)

`README.ja.md` says the same as `README.md`, in Japanese.

## docs/usage.md

The README links here for every feature, so it is read by someone already using the plugin, who comes to:

- **find how to do something**: a task-named heading, then numbered steps;
- **understand what a screen shows**: what each part means, in the words the screen uses;
- **fix a problem**: the symptom as seen, then the fix.

What follows: headings name tasks or screens, not components. Procedures are numbered steps. UI names match `plugin/src/i18n/locales/en.ts`. Short tables only for comparable values (menu item → what it does). Pictures where they show a screen. Every fact the plugin's behavior depends on stays; how it was built goes to `design.md`.

## Reviewing a README change

Read the change once as each reader above and ask whether they can do what they came for. Ask the Cautious user's question literally: after the uninstall steps, what is still on disk, and does the README say so?

Then check the whole page: tables with sentences in cells, history or work records, words that sell or alarm, and links whose anchors no longer exist.
