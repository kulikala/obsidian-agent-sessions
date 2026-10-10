// The checks Obsidian's community plugin review runs: eslint-plugin-obsidianmd's recommended rules,
// including the sentence-case check of the English locale module.
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import { PlainTextParser } from "eslint-plugin-obsidianmd/dist/lib/plainTextParser.js";
import tseslint from "typescript-eslint";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";

// The sentence-case check keeps as written: the names of the agents, models and programs the plugin
// runs or mentions, and the labels of the menu items, buttons, keys and views a sentence refers to.
// Left out: strings that start in lower case or with a number, which are fragments set inside
// another sentence or a count with its unit; a prompt the plugin sends to an agent; and strings
// that quote a command line, a command or a name format, or name a path, a model ID or a site.
const sentenceCase = {
  brands: [
    ...DEFAULT_BRANDS,
    "Agent Sessions", "Claude Code", "Codex", "OpenCode", "Ollama", "Opus", "Opus Plan", "Sonnet", "Haiku",
    "Python", "WinGet", "Microsoft Store", "App Installer", "Remote Control", "Session manager",
    "Move to category", "Stretch your usage limit",
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  ],
  acronyms: [...DEFAULT_ACRONYMS, "README"],
  ignoreWords: ["Rename", "Apply", "Analyze", "Settings", "Agents", "Enter", "Esc", "Tab", "KEY", "VALUE"],
  ignoreRegex: ["^[a-z( ]", "^\\d", "^\\| ", "^- ", "[“\"]", "~/", "claude-opus", "python\\.org"],
};

export default defineConfig([
  globalIgnores(["main.js", "node_modules/**"]),
  ...obsidianmd.configs.recommendedWithLocalesEn,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs", "version-bump.mjs", "vitest.config.ts", "test/fixtures/*.cjs"],
        },
      },
      globals: { __AGENT_SESSIONS_DEV__: "readonly" },
    },
    rules: {
      "obsidianmd/ui/sentence-case": ["warn", { ...sentenceCase, enforceCamelCaseLower: true }],
      "obsidianmd/ui/sentence-case-locale-module": ["warn", sentenceCase],
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      // The built-in editor inserts text with `execCommand("insertText")`, the one way that keeps
      // the edit in the textarea's undo history; it falls back to `setRangeText` where it fails.
      "@typescript-eslint/no-deprecated": ["warn", { allow: [{ from: "lib", name: "execCommand" }] }],
    },
  },
  // The tests run in Node, outside Obsidian's windows: the popout-window rules don't apply there.
  {
    files: ["test/**"],
    rules: {
      "obsidianmd/prefer-window-timers": "off",
      "obsidianmd/no-global-this": "off",
    },
  },
  // The manifest and the license, which the recommended set leaves to the review's own run.
  {
    files: ["manifest.json"],
    plugins: { obsidianmd },
    languageOptions: { parser: tseslint.parser, parserOptions: { projectService: false } },
    rules: { "obsidianmd/validate-manifest": "error" },
  },
  {
    files: ["LICENSE"],
    plugins: { obsidianmd },
    languageOptions: { parser: PlainTextParser, parserOptions: { projectService: false } },
    rules: { "obsidianmd/validate-license": "error" },
  },
]);
