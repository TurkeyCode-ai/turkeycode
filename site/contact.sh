#!/bin/sh
# contact.sh: print saved contact enquiries, oldest first / newest last.
#
# Usage:
#   sh contact.sh [file]
#
# The file is the first argument, else $CONTACT_FILE, else /data/contact.jsonl.
# Each line of the file is one JSON object (see README, Contact page). A
# missing or empty file prints a clear "no enquiries" line; malformed lines
# are skipped. No dependencies beyond node, which is in the image.

FILE="${1:-${CONTACT_FILE:-/data/contact.jsonl}}"

if [ ! -f "$FILE" ] || [ ! -s "$FILE" ]; then
  echo "no enquiries ($FILE is missing or empty)"
  exit 0
fi

node -e '
const fs = require("fs");
const file = process.argv[1];
const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
let shown = 0;
for (const line of lines) {
  let r;
  try { r = JSON.parse(line); } catch (err) { continue; }
  if (!r || typeof r !== "object") continue;
  const f = (v) => (v === undefined || v === null || v === "" ? "-" : String(v));
  shown++;
  console.log("enquiry " + shown);
  console.log("  time:       " + f(r.time));
  console.log("  name:       " + f(r.name));
  console.log("  email:      " + f(r.email));
  console.log("  company:    " + f(r.company));
  console.log("  timeline:   " + f(r.timeline));
  console.log("  email sent: " + (r.emailSent ? "yes" : "no"));
  console.log("  description:");
  for (const dl of f(r.description).split(/\r?\n/)) console.log("    " + dl);
  console.log("");
}
if (shown === 0) console.log("no enquiries (no readable lines in " + file + ")");
' "$FILE"
