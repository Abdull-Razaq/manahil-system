// Usage:  node patch-index.mjs            (run in the folder that holds index.html)
// Makes a backup (index.original.html) and then connects index.html to your own database.
// Safe to run twice: it does nothing if the file is already patched.
import fs from "node:fs";

const FILE = process.argv[2] || "index.html";
const MARK = "<!-- mms-backend -->";
let html = fs.readFileSync(FILE, "utf8");

if (html.includes(MARK)) { console.log("Already patched. Nothing to do."); process.exit(0); }
if (!fs.existsSync("index.original.html")) fs.copyFileSync(FILE, "index.original.html");

function swap(label, from, to, expected = 1) {
  const n = html.split(from).length - 1;
  if (n !== expected) { console.error(`STOP: "${label}" matched ${n} times (expected ${expected}). The file is not the version this script was written for. Nothing was changed.`); process.exit(1); }
  html = html.split(from).join(to);
  console.log("  done: " + label);
}

// 1. Load the database library, your settings and the adapter before the app starts.
swap("load Supabase + adapter",
  '<script>try{document.documentElement.setAttribute("data-theme","light")}catch(_){}</script>',
  MARK + '\n<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>\n<script src="config.js"></script>\n<script src="claude-shim.js"></script>\n' +
  '<script>try{document.documentElement.setAttribute("data-theme","light")}catch(_){}</script>');

// 2. Before anyone has signed in, nobody is the owner. (The original gave the owner view to "nobody").
swap("nobody is owner before sign-in",
  'function roleOf(){if(!ME)return"owner";',
  'function roleOf(){if(!ME)return"loading";');
swap("owner buttons need a real owner",
  'const isOwner=()=>!ME||ME.isOwner!==false;',
  'const isOwner=()=>!!ME&&ME.isOwner===true;');

// 3. Replace the Claude-specific sentence.
swap("connection message",
  "Records can't be saved in this view. Open the page in Claude while signed in to keep your records.",
  "Could not connect to the database. Check your internet connection and reload the page.", 2);

// 4. Sentences that told people to share the page inside Claude.
swap("parent steps, line 1",
  "1. Share the link with the parent (the link must be set to <b>Anyone with the link</b>, or invite them as <b>Viewer</b>). They sign in to Claude and open it.",
  "1. Give the parent the website address. They create an account and sign in.");
swap("staff request note",
  " Staff must first be shared the system as <b>Editor</b>.",
  "");
swap("request failed message",
  "You need to be shared the system as Editor first. Ask the owner.",
  "Your request could not be sent. Check your connection and try again.");

fs.writeFileSync(FILE, html);
console.log("\nPatched " + FILE + ". The untouched original is index.original.html");
