#!/bin/sh
# stats.sh: report visitors from the turkeycode site event log.
#
# Usage:
#   sh stats.sh [logfile]          per page visitors, actions and reference counts
#   sh stats.sh --daily [logfile]  one row per UTC day plus a matching totals row
#
# The log path is the first non-flag argument, else $LOG_FILE, else
# /data/events.log. A missing or empty log prints zeros; malformed lines are
# ignored. The two arguments may appear in either order.
#
# Log line format (five fields):
#   <ISO-8601 UTC timestamp> <a|b> <view|copy|outbound> <split|direct|bot> <first|repeat>
#
# The comparison is computed from five-field split lines only (pages served
# at /). Per page: visitors counts 'view split first' lines, acted counts
# first split copy or outbound events, and conversion is acted / visitors.
# Total split copy and outbound events are printed for reference. Direct
# views (pages served at /a/ or /b/) and bot views (known crawlers) are
# reported separately and are not part of the comparison. Legacy three- and
# four-field lines, written before visitor counting began, are left out of
# the visitor figures; their views are reported on one labelled line.

DAILY=0
LOG=""
for arg in "$@"; do
  if [ "$arg" = "--daily" ]; then
    DAILY=1
  else
    LOG="$arg"
  fi
done
LOG="${LOG:-${LOG_FILE:-/data/events.log}}"

if [ -f "$LOG" ] && [ -r "$LOG" ]; then
  INPUT="$LOG"
else
  INPUT="/dev/null"
fi

awk -v daily="$DAILY" '
  function conv(acted, vis) {
    if (vis > 0) return sprintf("%.1f%%", acted * 100 / vis)
    return "0.0%"
  }
  # Every counted line starts with a timestamp, a page and an event.
  $1 !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/ { next }
  $2 != "a" && $2 != "b" { next }
  $3 != "view" && $3 != "copy" && $3 != "outbound" { next }
  # Legacy lines from before visitor counting began: three fields, or four
  # fields with a known reach. Their views go on one labelled line and
  # nothing else about them is counted.
  NF == 3 { if ($3 == "view") legacy++; next }
  NF == 4 { if (($4 == "split" || $4 == "direct") && $3 == "view") legacy++; next }
  NF != 5 { next }
  $5 != "first" && $5 != "repeat" { next }
  $4 == "split" {
    if ($3 == "view" && $5 == "first") vis[$2]++
    if ($3 != "view" && $5 == "first") act[$2]++
    if ($3 == "copy") cop[$2]++
    if ($3 == "outbound") outb[$2]++
    d = substr($1, 1, 10)
    if (!(d in seen)) { seen[d] = 1; days[++ndays] = d }
    if ($3 == "view" && $5 == "first") dvis[d "." $2]++
    if ($3 != "view" && $5 == "first") dact[d "." $2]++
    next
  }
  $4 == "direct" { if ($3 == "view") dir[$2]++; next }
  $4 == "bot" { if ($3 == "view") bots[$2]++; next }
  END {
    if (daily) {
      # Insertion sort; ISO dates sort oldest first lexically.
      for (i = 2; i <= ndays; i++) {
        d = days[i]
        j = i - 1
        while (j >= 1 && days[j] > d) { days[j + 1] = days[j]; j-- }
        days[j + 1] = d
      }
      printf "Split visitors per UTC day; acted = first copy or outbound; the total row matches plain stats.sh\n"
      printf "%-12s%12s%9s%8s%12s%9s%8s\n", "day", "a visitors", "a acted", "a conv", "b visitors", "b acted", "b conv"
      for (i = 1; i <= ndays; i++) {
        d = days[i]
        av = dvis[d ".a"] + 0
        aa = dact[d ".a"] + 0
        bv = dvis[d ".b"] + 0
        ba = dact[d ".b"] + 0
        printf "%-12s%12d%9d%8s%12d%9d%8s\n", d, av, aa, conv(aa, av), bv, ba, conv(ba, bv)
      }
      av = vis["a"] + 0; aa = act["a"] + 0
      bv = vis["b"] + 0; ba = act["b"] + 0
      printf "%-12s%12d%9d%8s%12d%9d%8s\n", "total", av, aa, conv(aa, av), bv, ba, conv(ba, bv)
    } else {
      printf "Visitors per page from split lines; acted = first copy or outbound; conversion = acted / visitors\n"
      n = split("a b", pages, " ")
      for (i = 1; i <= n; i++) {
        p = pages[i]
        v = vis[p] + 0
        a = act[p] + 0
        printf "page %s:  visitors=%7d  acted=%7d  conversion=%7s\n", p, v, a, conv(a, v)
      }
      for (i = 1; i <= n; i++) {
        p = pages[i]
        printf "page %s:  copies=%9d  outbound=%4d  (split event totals, for reference)\n", p, cop[p] + 0, outb[p] + 0
      }
      for (i = 1; i <= n; i++) {
        p = pages[i]
        printf "page %s:  direct views=%3d  (not part of the comparison)\n", p, dir[p] + 0
      }
      for (i = 1; i <= n; i++) {
        p = pages[i]
        printf "page %s:  bot views=%6d  (not part of the comparison)\n", p, bots[p] + 0
      }
      printf "views logged before visitor counting began: %d\n", legacy + 0
    }
  }
' "$INPUT"
