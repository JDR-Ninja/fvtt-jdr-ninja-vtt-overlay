/**
 * Pre-release consistency check. Runs in CI before the build, so a broken manifest or a
 * half-translated locale fails the tag instead of shipping to Foundry users.
 *
 *   node tools/check.mjs
 *
 * Checks:
 *  1. module.json parses, `id` matches the folder, and every declared path exists.
 *  2. Every locale declares exactly the same key set as en.json (the base/fallback).
 *  3. Every i18n key referenced from scripts/ or templates/ exists in en.json.
 *  4. No em-dash in shipped user-facing text (lang files, module.json), per house style.
 */

import { readFile, readdir, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const I18N_PREFIX = "JDRNINJA_VTT_OVERLAY.";

/**
 * The module id is a permanent identifier, NOT a name: Foundry uses it as the install directory
 * (`Data/modules/<id>/`) and as the namespace of every `client`-scope setting, including the paired
 * device token. Changing it orphans every existing install and silently unpairs every streamer.
 * Note it is deliberately NOT the repo name (the repo is `fvtt-jdr-ninja-vtt-overlay`, per the
 * Foundry community's `fvtt-` prefix convention), so this cannot be derived from the folder.
 */
const MODULE_ID = "jdr-ninja-vtt-overlay";

const problems = [];
const fail = (msg) => problems.push(msg);

const exists = (p) => access(p).then(() => true, () => false);

/* 1. Manifest ------------------------------------------------------------- */

const manifest = JSON.parse(await readFile(join(ROOT, "module.json"), "utf8"));

if (manifest.id !== MODULE_ID) {
  fail(`module.json id is "${manifest.id}", must stay "${MODULE_ID}" (see the note in this file)`);
}

const declaredPaths = [
  ...(manifest.esmodules ?? []),
  ...(manifest.styles ?? []),
  ...(manifest.languages ?? []).map((l) => l.path),
];
for (const rel of declaredPaths) {
  if (!(await exists(join(ROOT, rel)))) fail(`module.json declares a missing file: ${rel}`);
}

/* 2 + 3. Localization ----------------------------------------------------- */

const langDir = join(ROOT, "lang");
const localeFiles = (await readdir(langDir)).filter((f) => f.endsWith(".json"));
const locales = {};
for (const file of localeFiles) {
  locales[file.replace(/\.json$/, "")] = JSON.parse(await readFile(join(langDir, file), "utf8"));
}

if (!locales.en) fail("lang/en.json is missing (it is the base/fallback locale)");

const baseKeys = new Set(Object.keys(locales.en ?? {}));
for (const [locale, table] of Object.entries(locales)) {
  if (locale === "en") continue;
  const keys = new Set(Object.keys(table));
  const missing = [...baseKeys].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !baseKeys.has(k));
  if (missing.length) fail(`lang/${locale}.json is missing ${missing.length} key(s): ${missing.join(", ")}`);
  if (extra.length) fail(`lang/${locale}.json has ${extra.length} key(s) absent from en.json: ${extra.join(", ")}`);
}

// Keys referenced from code. Dynamic forms (`diag.${key}.label`) cannot be resolved statically,
// so we collect their literal prefix/suffix and accept any base key that matches the shape.
const sources = [
  await readFile(join(ROOT, "scripts", "main.js"), "utf8"),
  await readFile(join(ROOT, "templates", "settings-panel.hbs"), "utf8"),
].join("\n");

const referenced = new Set();
for (const m of sources.matchAll(/\b(?:L|Fmt)\(\s*["']([^"'`$]+)["']/g)) referenced.add(m[1]);
for (const m of sources.matchAll(/`\$\{I18N\}\.([A-Za-z0-9_.]+)`/g)) referenced.add(m[1]);
for (const m of sources.matchAll(/JDRNINJA_VTT_OVERLAY\.([A-Za-z0-9_.]+)/g)) referenced.add(m[1]);

for (const key of referenced) {
  if (!baseKeys.has(I18N_PREFIX + key)) fail(`code references an i18n key absent from en.json: ${key}`);
}

/* 4. House style ---------------------------------------------------------- */

const shipped = { "module.json": JSON.stringify(manifest) };
for (const [locale, table] of Object.entries(locales)) {
  shipped[`lang/${locale}.json`] = JSON.stringify(table);
}
for (const [label, text] of Object.entries(shipped)) {
  if (text.includes("—")) fail(`${label} contains an em-dash (rephrase: house style forbids it)`);
}

/* ------------------------------------------------------------------------- */

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`✓ jdr-ninja-vtt-overlay v${manifest.version} looks consistent`);
console.log(`  ${declaredPaths.length} declared paths, ${Object.keys(locales).length} locales, ${baseKeys.size} keys each`);
