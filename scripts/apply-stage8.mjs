// Run once after unzipping farrey-stage8.zip:  node scripts/apply-stage8.mjs
// Adds the updater plugin to Cargo.toml, an (empty-key) updater block to tauri.conf.json
// and the `updater:enable` npm script. It leaves your version numbers alone and is safe to
// run again.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/* ---- Cargo.toml ---- */
const cargoPath = "src-tauri/Cargo.toml";
let cargo = readFileSync(cargoPath, "utf8");
if (!/^tauri-plugin-updater\s*=/m.test(cargo)) {
  if (!/^tauri-plugin-autostart\s*=.*$/m.test(cargo)) {
    fail("Could not find the tauri-plugin-autostart line in src-tauri/Cargo.toml.");
  }
  cargo = cargo.replace(
    /^(tauri-plugin-autostart\s*=.*)$/m,
    '$1\ntauri-plugin-updater = "2"',
  );
  writeFileSync(cargoPath, cargo);
  console.log("added tauri-plugin-updater to Cargo.toml");
} else {
  console.log("Cargo.toml already has tauri-plugin-updater");
}

/* ---- tauri.conf.json ---- */
const confPath = "src-tauri/tauri.conf.json";
const conf = JSON.parse(readFileSync(confPath, "utf8"));
const repo = cargo.match(/^repository\s*=\s*"([^"]+)"/m)?.[1];
if (!repo)
  fail(
    'Add `repository = "https://github.com/<you>/<repo>"` to src-tauri/Cargo.toml first.',
  );

conf.plugins ??= {};
conf.plugins.updater ??= {};
conf.plugins.updater.endpoints ??= [`${repo}/releases/latest/download/latest.json`];
// An empty key keeps updates switched off. `npm run updater:enable` fills it in.
conf.plugins.updater.pubkey ??= "";
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
console.log(
  "tauri.conf.json: updater block ready (updates stay OFF until you add a key)",
);

/* ---- .gitignore: never commit a signing key ---- */
let ignore = "";
try {
  ignore = readFileSync(".gitignore", "utf8");
} catch {
  /* no .gitignore yet */
}
if (!/^\*\.key$/m.test(ignore)) {
  writeFileSync(
    ".gitignore",
    `${ignore.replace(/\n*$/, "\n")}\n# Update-signing private keys must never be committed\n*.key\n.tauri/\n`,
  );
  console.log("added *.key to .gitignore");
}

/* ---- package.json ---- */
const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.scripts ??= {};
pkg.scripts["updater:enable"] ??= "node scripts/enable-updater.mjs";
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

try {
  execSync(`npx prettier --write ${pkgPath} ${confPath}`, { stdio: "ignore" });
} catch {
  console.warn("Could not run prettier. Run `npm run format` before committing.");
}
console.log("\nDone. Next: see docs/UPDATES.md");
