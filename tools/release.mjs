/**
 * Cut a release of JDR Ninja VTT Overlay.
 *
 *   node tools/release.mjs patch     1.0.0 -> 1.0.1
 *   node tools/release.mjs minor     1.0.0 -> 1.1.0
 *   node tools/release.mjs major     1.0.0 -> 2.0.0
 *   node tools/release.mjs 1.4.2     set an explicit version
 *
 * It bumps module.json's `version`, re-points `download` at the new tag, runs the
 * consistency check and then the build to produce module.zip. It does NOT git
 * commit/tag/push: that stays in your hands.
 *
 * This is a convenience, not a requirement. The release workflow stamps the tag's version
 * into module.json itself, so tagging on GitHub ships correctly even when the committed
 * module.json still carries the previous version. Run this when you want the repo to record
 * the version it shipped, or to build the exact release zip locally.
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stamp } from "./stamp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "module.json");

function bump(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`current version "${version}" is not semver x.y.z`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump "${kind}" (use patch|minor|major or an explicit x.y.z)`);
}

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node tools/release.mjs <patch|minor|major|x.y.z>");
  process.exit(1);
}

const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
const next = /^\d+\.\d+\.\d+$/.test(arg) ? arg : bump(manifest.version, arg);

await stamp(next);
console.log(`✓ module.json -> v${next}`);

execFileSync(process.execPath, [join(ROOT, "tools", "check.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [join(ROOT, "tools", "build.mjs")], { stdio: "inherit" });

console.log("");
console.log("Next steps:");
console.log(`  update CHANGELOG.md for v${next}`);
console.log(`  git add module.json CHANGELOG.md && git commit -m "release: v${next}"`);
console.log(`  git tag v${next} && git push --follow-tags`);
console.log(`  -> the Release workflow builds and publishes module.json + module.zip`);
console.log(`  (or skip the local tag and create v${next} on GitHub: the workflow does the rest)`);
