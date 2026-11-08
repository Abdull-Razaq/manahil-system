// Usage:  node patch-index.mjs
// Builds index.html from your untouched original, applying every edit listed in patch-edits.json.
//  - The first run saves your original as index.original.html and never changes it.
//  - Every run starts again from that original, so you can run it as often as you like
//    (for example after receiving a new patch-edits.json).
//  - Do not hand-edit index.html: the next run replaces it. Put your own changes in patch-edits.json.
import fs from "node:fs";

const FILE = "index.html", ORIG = "index.original.html", MARK = "<!-- mms-backend -->";
if (!fs.existsSync(ORIG)) {
  if (fs.readFileSync(FILE, "utf8").includes(MARK)) {
    console.error("STOP: index.html is already patched and there is no index.original.html to start from."); process.exit(1);
  }
  fs.copyFileSync(FILE, ORIG);
}
let html = fs.readFileSync(ORIG, "utf8");
const edits = JSON.parse(fs.readFileSync("patch-edits.json", "utf8"));

for (const e of edits) {
  if (e.until) {                                   // replace everything from e.from up to and including e.until
    const i = html.indexOf(e.from), j = i < 0 ? -1 : html.indexOf(e.until, i);
    if (i < 0 || j < 0) { console.error(`STOP: "${e.label}" was not found. Nothing was changed.`); process.exit(1); }
    html = html.slice(0, i) + e.to + html.slice(j + e.until.length);
  } else {
    const n = html.split(e.from).length - 1;
    if (n !== e.expected) { console.error(`STOP: "${e.label}" matched ${n} times (expected ${e.expected}). Nothing was changed.`); process.exit(1); }
    html = html.split(e.from).join(e.to);
  }
  console.log("  done: " + e.label);
}
fs.writeFileSync(FILE, html);
console.log(`\nBuilt ${FILE} from ${ORIG} with ${edits.length} edits. Reload the page with Ctrl+Shift+R.`);
