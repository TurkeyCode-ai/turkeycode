#!/bin/bash
# Check status of all TurkeyCode builds
BUILD_DIR="${1:-$HOME/test-builds}"

if [ ! -d "$BUILD_DIR" ]; then
  echo "No builds directory at $BUILD_DIR"
  exit 0
fi

for dir in "$BUILD_DIR"/*/; do
  [ ! -d "$dir" ] && continue
  name=$(basename "$dir")
  log="$dir/build.log"
  
  if [ ! -f "$log" ]; then
    echo "[$name] ⚪ No log file"
    continue
  fi

  # Check if running (node process or claude child process)
  running=$(ps aux | grep -E "test-builds/$name|claude.*$name" | grep -v grep | wc -l)
  # Also check if log was updated in last 5 minutes
  if [ "$running" = "0" ]; then
    age=$(( $(date +%s) - $(stat -c %Y "$log" 2>/dev/null || echo 0) ))
    [ "$age" -lt 300 ] && running=1
  fi
  
  # Get latest phase
  phase=$(grep -oE "RESEARCH|PLAN|BUILD PHASE|QA|MERGE|quick-check" "$log" 2>/dev/null | tail -1)
  
  # Check for completion
  if grep -q "CLEAN" "$log" 2>/dev/null; then
    verdict="✅ CLEAN"
  elif grep -q "ERROR:" "$log" 2>/dev/null; then
    error=$(grep "ERROR:" "$log" | tail -1 | sed 's/.*ERROR: //')
    verdict="❌ $error"
  elif grep -q "FAILED" "$log" 2>/dev/null; then
    verdict="⚠️ QA issues"
  else
    verdict="🔨 In progress"
  fi

  # Get QA attempts
  qa_count=$(ls "$dir/.turkey/qa/phase-1/verdict-"*.json 2>/dev/null | wc -l)
  
  if [ "$running" -gt 0 ]; then
    status="🟢 running"
  else
    status="⚫ stopped"
  fi
  
  echo "[$name] $status | $verdict | Phase: ${phase:-init} | QA attempts: $qa_count"
done
