// Cache busting for GitHub Pages, which lets browsers keep files for 10 minutes:
// a fresh index.html with yesterday's JavaScript shows broken text. This stamps
// index.html with a hash of the scripts and styles: the page's own links get
// "?v=<hash>", and an import map does the same for every module the scripts
// import, so a new version always loads as a whole.
//
//   node web/tools/stamp.mjs          update web/index.html
//   node web/tools/stamp.mjs --check  fail if web/index.html is out of date (CI)

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const MODULE_DIRS = ["js", "vendor"];
const START = "<!-- stamp:start -->";
const END = "<!-- stamp:end -->";

const files = (dir, test) =>
  readdirSync(WEB + dir)
    .filter((f) => test.test(f))
    .sort()
    .map((f) => `${dir}/${f}`);

export function currentStamp() {
  const modules = MODULE_DIRS.flatMap((d) => files(d, /\.m?js$/));
  const hash = createHash("sha256");
  for (const f of [...modules, ...files("css", /\.css$/)]) hash.update(f).update("\0").update(readFileSync(WEB + f)).update("\0");
  return { version: hash.digest("hex").slice(0, 10), modules };
}

export function stampedHtml(html, { version, modules }) {
  const imports = Object.fromEntries(modules.map((f) => [`./${f}`, `./${f}?v=${version}`]));
  const block = [
    START,
    `  <script type="importmap">${JSON.stringify({ imports })}</script>`,
    `  <link rel="stylesheet" href="css/app.css?v=${version}">`,
    `  <script type="module" src="js/app.js?v=${version}"></script>`,
    `  ${END}`,
  ].join("\n");
  const at = html.indexOf(START);
  const until = html.indexOf(END);
  if (at < 0 || until < at) throw new Error(`index.html has no ${START} … ${END} block`);
  return html.slice(0, at) + block + html.slice(until + END.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = WEB + "index.html";
  const html = readFileSync(path, "utf8");
  const stamp = currentStamp();
  const next = stampedHtml(html, stamp);
  if (process.argv.includes("--check")) {
    if (next !== html) {
      console.error("web/index.html is not stamped for the current scripts: run `node web/tools/stamp.mjs` and commit.");
      process.exit(1);
    }
    console.log(`web/index.html stamp ${stamp.version} is up to date`);
  } else {
    writeFileSync(path, next);
    console.log(`web/index.html stamped ${stamp.version}`);
  }
}
