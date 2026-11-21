// Usage: npm run updater:enable -- ~/.tauri/farrey.key.pub
//    or: npm run updater:enable -- "<the public key text>"
// Turns updates ON: stores the PUBLIC key in tauri.conf.json and makes release builds
// produce signed update files. Never pass the private key: this script refuses it.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) {
  fail("Usage: npm run updater:enable -- ~/.tauri/farrey.key.pub");
}

const path = arg.startsWith("~/") ? arg.replace("~", homedir()) : arg;
const value = (existsSync(path) ? readFileSync(path, "utf8") : arg).trim();

let decoded = "";
try {
  decoded = Buffer.from(value, "base64").toString("utf8");
} catch {
  /* handled below */
}
if (/secret key/i.test(decoded) || /secret key/i.test(value)) {
  fail(
    "That is your PRIVATE key. Never put it in the project or share it.\n" +
      "Use the file that ends in .pub (for example ~/.tauri/farrey.key.pub).",
  );
}
if (
  !decoded.startsWith("untrusted comment:") ||
  !/public key/i.test(decoded.split("\n")[0])
) {
  fail(
    "That does not look like a Tauri public key.\n" +
      "Create one with:  npx tauri signer generate -w ~/.tauri/farrey.key\n" +
      "then pass the .pub file:  npm run updater:enable -- ~/.tauri/farrey.key.pub",
  );
}

const confPath = "src-tauri/tauri.conf.json";
const conf = JSON.parse(readFileSync(confPath, "utf8"));
if (!conf.plugins?.updater) {
  fail("Run `node scripts/apply-stage8.mjs` first.");
}
conf.plugins.updater.pubkey = value;
conf.bundle ??= {};
conf.bundle.createUpdaterArtifacts = true;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

try {
  execSync(`npx prettier --write ${confPath}`, { stdio: "ignore" });
} catch {
  console.warn("Could not run prettier. Run `npm run format` before committing.");
}

console.log(`Updates are now ON in ${confPath}.`);
console.log("Builds now need TAURI_SIGNING_PRIVATE_KEY (see docs/UPDATES.md, step 3).");
