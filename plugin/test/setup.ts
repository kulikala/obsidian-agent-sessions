// The default test language is English, matching the app's actual default (i18n.ts's
// `currentLang` starts as "en", and "auto" falls back to English unless Obsidian's own
// language is Japanese). Tests that need to check Japanese-specific output set the
// language explicitly (and reset it afterward) rather than relying on this default.
import { setLang } from "../src/i18n";

setLang("en");
