/**
 * Build for JDR Ninja VTT Overlay.
 *
 * Bundles the ESM entry point into a single minified scripts/main.js, stages the static
 * assets (module.json, styles, templates, lang, README, LICENSE, CHANGELOG) into dist/,
 * then zips dist/ into module.zip, the artifact attached to a GitHub release and pointed
 * at by module.json's `download` field.
 *
 *   node tools/build.mjs           one-shot build + module.zip
 *   node tools/build.mjs --watch   rebuild the bundle on change (no zip)
 */

import { build, context } from "esbuild";
import archiver from "archiver";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const WATCH = process.argv.includes("--watch");

/** Files/folders copied verbatim into dist/ (the bundle replaces scripts/). */
const STATIC_ASSETS = ["module.json", "styles", "templates", "lang", "README.md", "LICENSE", "CHANGELOG.md"];

const bundleOptions = {
  entryPoints: [join(ROOT, "scripts", "main.js")],
  outfile: join(DIST, "scripts", "main.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  // Deliberately NOT minified. Support for a Foundry module happens through the user's F12
  // console, so a readable stack trace is worth far more than the few KiB minification saves
  // here (the lang files dominate the zip either way). The bundle step stays because it keeps
  // a single entry point and normalizes the shipped output.
  minify: false,
  sourcemap: WATCH ? "inline" : false,
  legalComments: "none",
  // Foundry globals (game, ui, Hooks, foundry, CONFIG, …) are left as runtime globals.
};

async function stageAssets() {
  for (const asset of STATIC_ASSETS) {
    await cp(join(ROOT, asset), join(DIST, asset), { recursive: true }).catch((err) => {
      if (err.code !== "ENOENT") throw err;
      console.warn(`  ! skipped missing asset: ${asset}`);
    });
  }
}

function zipDist() {
  return new Promise((resolvePromise, reject) => {
    const out = createWriteStream(join(ROOT, "module.zip"));
    const archive = archiver("zip", { zlib: { level: 9 } });
    out.on("close", () => resolvePromise(archive.pointer()));
    archive.on("warning", (err) => (err.code === "ENOENT" ? null : reject(err)));
    archive.on("error", reject);
    archive.pipe(out);
    // Files at the zip root so module.json sits at the top level on install.
    archive.directory(DIST, false);
    archive.finalize();
  });
}

async function readVersion() {
  const manifest = JSON.parse(await readFile(join(ROOT, "module.json"), "utf8"));
  return manifest.version;
}

if (WATCH) {
  const ctx = await context(bundleOptions);
  await ctx.watch();
  console.log("watching scripts/ … (Ctrl+C to stop)");
} else {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await build(bundleOptions);
  await stageAssets();
  const bytes = await zipDist();
  const version = await readVersion();
  console.log(`✓ built jdr-ninja-vtt-overlay v${version}`);
  console.log(`  dist/        staged module (bundled, not minified)`);
  console.log(`  module.zip   ${(bytes / 1024).toFixed(1)} KiB`);
}
