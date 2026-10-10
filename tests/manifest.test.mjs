/**
 * Repository-wide checks for every package's manifest, run from the repository root.
 *
 * Two things a package must not get wrong on its own, because the damage shows up
 * only after it is installed into a profile:
 *
 *   - the directory name must equal the package name. A dsh plugin is resolved by
 *     its package name and mounted by it, so a mismatch installs nothing anyone
 *     can reach; the hub's discovery walks the root by the `dsh-` prefix, so the
 *     name is the address, not a label.
 *   - every bare import in the host half must be a dependency the manifest declares.
 *     It resolves here because the profile happens to have the package in its
 *     resolution farm, and then fails on a user's machine. Silently, since a failed
 *     import only costs that one row. The browser halves are exempt: a client bundle
 *     is a classic script served to the page, and it resolves dsh's own seed words
 *     rather than npm packages.
 *
 * Run from the repository root:
 *   node tests/manifest.test.mjs
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });

const read = (path) => readFileSync(join(root, path), "utf8");
const manifestOf = (pkg) => JSON.parse(read(join(pkg, "package.json")));

/** Every `dsh-*` directory at the root that carries a manifest, in name order. */
const PACKAGES = readdirSync(root, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && entry.name.startsWith("dsh-") && existsSync(join(root, entry.name, "package.json")))
	.map((entry) => entry.name)
	.sort();
check(PACKAGES.length >= 8, "every dsh- package at the root carries a manifest", String(PACKAGES.length));

/** A static import's specifier, at the two shapes this tree writes: `import ... from` and `export ... from`. */
const SPECIFIER = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gu;
/** Comment prose may quote an import; only the code lines are scanned. */
const stripComments = (source) => source.split(/\r?\n/u).filter((line) => !/^\s*(?:\*|\/\/|\/\*)/u.test(line)).join("\n");
/** `@scope/name` keeps two segments, a bare name one, so a subpath compares as its package. */
const packageNameOf = (specifier) => {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
};

for (const pkg of PACKAGES) {
	const manifest = manifestOf(pkg);
	check(manifest.name === pkg, `${pkg}: the directory name is the package name`, String(manifest.name));

	const declared = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];
	const missing = new Set();
	// The host half only: flat modules in lib/, minus the browser bundle.
	const hostModules = readdirSync(join(root, pkg, "lib")).filter((name) => name.endsWith(".js") && name !== "client.js");
	for (const file of hostModules) {
		for (const match of stripComments(read(join(pkg, "lib", file))).matchAll(SPECIFIER)) {
			const specifier = match[1] ?? match[2];
			if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
			const name = packageNameOf(specifier);
			if (!declared.includes(name)) missing.add(name);
		}
	}
	check(
		missing.size === 0,
		`${pkg}: every bare import in its host half is a declared dependency`,
		[...missing].join(", ")
	);
}

/* ----------------------------------------------------------------- report */

const failed = results.filter((item) => !item.ok);
for (const item of results) console.log(`${item.ok ? "ok  " : "FAIL"} ${item.label}${item.detail === "" ? "" : ` — ${item.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
