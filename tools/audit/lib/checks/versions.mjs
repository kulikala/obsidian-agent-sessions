// One version everywhere: both manifests, the package files, versions.json, and the what's-new
// entries the welcome guide shows.

const SEMVER = /^\d+\.\d+\.\d+$/;

function compare(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
	return 0;
}

export function checkVersions({ tree, report }) {
	const json = (p) => {
		const buffer = tree.read(p);
		if (!buffer) {
			report.fail("versions", p, "missing");
			return null;
		}
		try {
			return JSON.parse(buffer.toString("utf8"));
		} catch (err) {
			report.fail("versions", p, `not valid JSON: ${err.message}`);
			return null;
		}
	};
	const manifest = json("manifest.json");
	const pluginManifest = json("plugin/manifest.json");
	const pkg = json("plugin/package.json");
	const lock = json("plugin/package-lock.json");
	const versions = json("versions.json");
	if (!manifest) return;
	const { version, minAppVersion } = manifest;
	const bump = "run `cd plugin && npm version <patch|minor|major> --no-git-tag-version`, which updates them together";
	if (!SEMVER.test(version ?? "")) report.fail("versions", "manifest.json", `version "${version}" is not x.y.z`, "Obsidian and the release tag need a bare x.y.z");
	if (!SEMVER.test(minAppVersion ?? "")) report.fail("versions", "manifest.json", "minAppVersion is missing or not x.y.z", "set the oldest Obsidian version the plugin supports");
	if (pluginManifest && JSON.stringify(pluginManifest) !== JSON.stringify(manifest)) {
		report.fail("versions", "plugin/manifest.json", "differs from the root manifest.json", "keep them identical; the root copy is what Obsidian's review and BRAT read");
	}
	if (pkg && pkg.version !== version) report.fail("versions", "plugin/package.json", `version ${pkg.version}, manifest ${version}`, bump);
	if (lock) {
		if (lock.version !== version) report.fail("versions", "plugin/package-lock.json", `version ${lock.version}, manifest ${version}`, bump);
		const root = lock.packages?.[""]?.version;
		if (root !== undefined && root !== version) report.fail("versions", "plugin/package-lock.json", `packages[""].version ${root}, manifest ${version}`, bump);
	}
	if (versions) {
		if (!(version in versions)) report.fail("versions", "versions.json", `no entry for ${version}`, bump);
		else if (versions[version] !== minAppVersion) report.fail("versions", "versions.json", `${version} maps to ${versions[version]}, manifest's minAppVersion is ${minAppVersion}`, "make them equal");
		const newest = Object.keys(versions).filter((v) => SEMVER.test(v)).sort(compare).at(-1);
		if (newest && SEMVER.test(version ?? "") && compare(newest, version) > 0) report.fail("versions", "versions.json", `lists ${newest}, newer than the manifest's ${version}`, "remove it or bump the manifest");
	}
	const onboarding = tree.read("plugin/src/ui/onboarding-model.ts")?.toString("utf8");
	const block = onboarding && /export const WHATS_NEW[^=]*=\s*\{([\s\S]*?)\n\};/.exec(onboarding);
	if (block && SEMVER.test(version ?? "")) {
		for (const m of block[1].matchAll(/"(\d+\.\d+\.\d+)"\s*:/g)) {
			if (compare(m[1], version) > 0) report.fail("versions", "plugin/src/ui/onboarding-model.ts", `WHATS_NEW has ${m[1]}, newer than ${version}`, "key what's-new entries by the version they ship in");
		}
	}
}
