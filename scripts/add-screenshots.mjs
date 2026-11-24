// Usage: node scripts/add-screenshots.mjs
// Adds (or refreshes) a "Screenshots" section in README.md, placed just before the
// "Install" heading. Everything else in your README, including banners, is left alone.
import { readFileSync, writeFileSync } from "node:fs";

const START = "<!-- screenshots:start -->";
const END = "<!-- screenshots:end -->";

const section = `${START}
## Screenshots

<p align="center">
  <img src="docs/screenshots/hero.png" alt="A normal note with a formatting bar (left) and a README sticker showing an image (right)" width="900">
</p>

<table>
  <tr>
    <td align="center">
      <img src="docs/screenshots/normal-note.png" alt="A normal note with a heading, a bulleted list and the formatting bar" width="400"><br>
      <sub>Normal note: bold, italic, lists, headings, fonts and sizes</sub>
    </td>
    <td align="center">
      <img src="docs/screenshots/readme-mode.png" alt="A README sticker showing an image, a heading and a list" width="400"><br>
      <sub>README mode: Markdown with images, links and a table of contents</sub>
    </td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/shade.png" alt="A sticker and the same sticker rolled up to its title bar" width="640"><br>
  <sub>Window shade: double-click the title bar to roll a sticker up</sub>
</p>
${END}
`;

let readme;
try {
  readme = readFileSync("README.md", "utf8");
} catch {
  console.error("README.md not found. Run this from the project folder.");
  process.exit(1);
}

let result;
let where;
const startAt = readme.indexOf(START);
const endAt = readme.indexOf(END);
if (startAt !== -1 && endAt > startAt) {
  // Already added once: refresh it in place.
  result =
    readme.slice(0, startAt) + section.trimEnd() + readme.slice(endAt + END.length);
  where = "refreshed the existing Screenshots section";
} else {
  const install = readme.search(/^## Install\b/m);
  const license = readme.search(/^## License\b/m);
  if (install !== -1) {
    result = `${readme.slice(0, install)}${section}\n${readme.slice(install)}`;
    where = 'added a Screenshots section before "## Install"';
  } else if (license !== -1) {
    result = `${readme.slice(0, license)}${section}\n${readme.slice(license)}`;
    where = 'added a Screenshots section before "## License"';
  } else {
    result = `${readme.replace(/\s*$/, "\n")}\n${section}`;
    where = "added a Screenshots section at the end";
  }
}

writeFileSync("README.md", result);
console.log(`README.md: ${where}.`);
