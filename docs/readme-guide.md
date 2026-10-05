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
- **Stuck user.** Recognizes their problem in the words they saw on screen.
- **Cautious user.** Finds every network connection, program started, file read and file written, and the way to remove it all. Obsidian's plugin guidelines require these disclosures in the README.
- **Contributor.** Gets one link to the developer docs.

## What follows

Each point names the reader it serves.

- **The value comes first.** The first lines say what the plugin is and what it does for you, with a screenshot. (Browser)
- **Features are what the reader can do.** Not how they were built or tested. One short line per feature; the full list lives in `docs/usage.md`. (Browser)
- **Limits are stated next to the features.** Someone who cannot use it should find out before installing. (Browser)
- **Requirements, then supported setups, then install steps.** In that order, so nobody starts an install that cannot work. Details beyond the steps live in `docs/installation.md`. (Installer)
- **Troubleshooting starts with the symptom.** The bold part is what the user sees; the fix follows. Rare cases live in `docs/usage.md`. (Stuck user)
- **Disclosures are complete and concrete.** Real paths, real program names, what is sent where and when. Grouped by kind of access so a reader can check one kind at a time. (Cautious user)
- **Tables hold short values that are compared across rows.** A cell is a word, a path or a short phrase. Anything that needs a sentence goes in prose or a list outside the table. (Everyone scanning)
- **Facts are stated as they are now.** No test dates, machines, build numbers, task IDs, internal labels or history of changes; that belongs in commits. (Everyone: they need what is true today.)
- **Plain tone.** Say what it does and what it does not do. No superlatives, selling, warnings meant to worry, or explanations of the obvious. (Browser and cautious user: plain statements are easier to trust and check.)
- **Developer material is a link.** Build, test, release and design go in `docs/`. (Contributor, and a shorter page for everyone else.)
- **Every sentence earns its place.** If removing it changes nothing a reader can decide or do, remove it. (Everyone)

`README.ja.md` says the same as `README.md`, in Japanese.

## Reviewing a README change

Read the changed README once as each reader, and answer:

1. **Browser.** From the first screen alone, can you say what it is, what you would get, and whether it runs on your setup?
2. **Installer.** Are requirements and supported setups before the steps? Can you install without opening another page?
3. **Stuck user.** For each problem a new user is likely to hit, is the symptom written as it appears on screen, with a fix next to it?
4. **Cautious user.** Is every network use, program, read, write and removal step listed with a concrete name? Does it match the code?
5. **Contributor.** Is there a link to `docs/development.md`?

Then check the whole page: tables with sentences in cells, history or work records, words that sell or alarm, and links whose anchors no longer exist.
