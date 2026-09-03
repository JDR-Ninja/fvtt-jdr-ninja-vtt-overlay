/**
 * Stamp a version into module.json.
 *
 *   node tools/stamp.mjs 1.0.1
 *
 * Sets `version`, pins `download` at that version's tag and re-points `manifest` at the
 * moving `latest` URL. Used by tools/release.mjs for a local bump, and by
 * .github/workflows/release.yml so that a tag created straight on GitHub carries a correct
 * manifest without needing a prior commit.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "module.json");
const REPO = "JDR-Ninja/fvtt-jdr-ninja-vtt-overlay";

/** Writes `version` and the two release URLs into module.json. Returns the version. */
export async function stamp(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`"${version}" is not semver x.y.z`);

  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  manifest.version = version;
  // `manifest` must stay on the moving `latest` URL: that is how installed copies detect an
  // update. `download` is pinned to this tag so an old manifest keeps resolving to its own zip.
  manifest.manifest = `https://github.com/${REPO}/releases/latest/download/module.json`;
  manifest.download = `https://github.com/${REPO}/releases/download/v${version}/module.zip`;

  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return version;
}

// CLI: `node tools/stamp.mjs <x.y.z>`.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node tools/stamp.mjs <x.y.z>");
    process.exit(1);
  }
  await stamp(arg);
  console.log(`✓ module.json -> v${arg}`);
}
