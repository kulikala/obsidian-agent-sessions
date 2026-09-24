import { readFileSync, writeFileSync } from "fs";

// Run as npm's `version` script, with cwd expected to be plugin/ (`cd plugin && npm version <bump>`).
const targetVersion = process.env.npm_package_version;

// plugin/manifest.json: bring its version in line.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// The repo root's manifest.json is a copy of plugin/manifest.json.
// The review bot and BRAT only read the root copy, so it's kept in sync here.
writeFileSync("../manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// The repo root's versions.json: the minimum supported Obsidian version per plugin version.
const versionsPath = "../versions.json";
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync(versionsPath, JSON.stringify(versions, null, "\t") + "\n");
}
