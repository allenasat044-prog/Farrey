// Usage: npm run version:set -- 0.2.0
// Keeps package.json, tauri.conf.json and Cargo.toml on the same version.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: npm run version:set -- <major.minor.patch>   e.g. 0.2.0");
  process.exit(1);
}

function updateJson(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  data.version = version;
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  console.log(`updated ${path}`);
}

updateJson("package.json");
updateJson("src-tauri/tauri.conf.json");

const cargoPath = "src-tauri/Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8");
const updated = cargo.replace(/^version = ".*"$/m, `version = "${version}"`);
if (updated === cargo && !cargo.includes(`version = "${version}"`)) {
  console.error("Could not find the package version line in Cargo.toml");
  process.exit(1);
}
writeFileSync(cargoPath, updated);
console.log(`updated ${cargoPath}`);

// Rewriting the JSON files changes their layout, so format them the way CI expects.
try {
  execSync("npx prettier --write package.json src-tauri/tauri.conf.json", {
    stdio: "inherit",
  });
} catch {
  console.warn("Could not run prettier. Run `npm run format` before committing.");
}
console.log(
  `\nVersion is now ${version}. Next: build once so Cargo.lock updates, then commit.`,
);
