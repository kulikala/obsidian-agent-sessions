// Most existing tests assert against Japanese-language output, so the default
// test language is Japanese; only the test that checks English (test/i18n.test.ts)
// switches it explicitly.
import { setLang } from "../src/i18n";

setLang("ja");
