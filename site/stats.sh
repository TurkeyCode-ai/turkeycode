#!/bin/sh
# stats.sh: summarise the turkeycode site event log per page.
#
# Usage:   sh stats.sh [logfile]
# The log path is the first argument, else $LOG_FILE, else /data/events.log.
# A missing or empty log prints all zeros; malformed lines are ignored.
#
# Log line format: <ISO-8601 UTC timestamp> <a|b> <view|copy|outbound> <split|direct>
# Legacy three-field lines (no fourth field) are counted as split.
#
# The A/B comparison is computed from split lines only (pages served at /).
# Direct views (pages served at /a/ or /b/) are reported separately and are
# not part of the comparison.

LOG="${1:-${LOG_FILE:-/data/events.log}}"

if [ -f "$LOG" ] && [ -r "$LOG" ]; then
  INPUT="$LOG"
else
  INPUT="/dev/null"
fi

awk '
  (NF == 3 || (NF == 4 && ($4 == "split" || $4 == "direct"))) &&
  ($2 == "a" || $2 == "b") &&
  ($3 == "view" || $3 == "copy" || $3 == "outbound") &&
  $1 ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/ {
    via = (NF == 4) ? $4 : "split"
    count[via " " $2 " " $3]++
  }
  END {
    pages = "a b"
    n = split(pages, list, " ")
    for (i = 1; i <= n; i++) {
      p = list[i]
      v = count["split " p " view"] + 0
      c = count["split " p " copy"] + 0
      o = count["split " p " outbound"] + 0
      if (v > 0) {
        share = sprintf("%.1f%%", (c + o) * 100 / v)
      } else {
        share = "0.0%"
      }
      printf "page %s: views=%d copies=%d outbound=%d engagement=%s\n", p, v, c, o, share
    }
    for (i = 1; i <= n; i++) {
      p = list[i]
      d = count["direct " p " view"] + 0
      printf "page %s: direct views=%d (not part of the comparison)\n", p, d
    }
  }
' "$INPUT"
