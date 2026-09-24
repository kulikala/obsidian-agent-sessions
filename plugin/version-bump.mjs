import { readFileSync, writeFileSync } from "fs";

// npm version の version スクリプトから、plugin/ で cwd 実行される想定（`cd plugin && npm version <bump>`）。
const targetVersion = process.env.npm_package_version;

// plugin/manifest.json: version を追従させる。
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// リポジトリ直下の manifest.json は plugin/manifest.json の写し。
// 審査 bot と BRAT は直下しか読まないため、ここで同期する。
writeFileSync("../manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// リポジトリ直下の versions.json: バージョンごとの最小対応 Obsidian バージョン。
const versionsPath = "../versions.json";
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync(versionsPath, JSON.stringify(versions, null, "\t") + "\n");
}
