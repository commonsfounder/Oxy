#!/bin/bash
# Codex builds the UI round after round on its own, looking at its own screenshots. Claude does backend and bugs, not UI.
# Stops after MAX_ROUNDS, when docs/ui-loop/STOP exists, or when either side reports a usage limit.
# Usage: scripts/ui-loop.sh [rounds]   (log: /tmp/ui-loop.log)

set -u
cd "$(dirname "$0")/.." || exit 1
MAX_ROUNDS="${1:-4}"
START_ROUND="${2:-1}"
while pgrep -f 'CodexCLI.app/Contents/MacOS/codex exec' >/dev/null; do sleep 10; done
CODEX="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
LOG=/tmp/ui-loop.log
OUT=/tmp/ui-loop
mkdir -p "$OUT"


limit_hit() { grep -qiE "usage limit|rate limit|quota|try again (at|in)" "$1"; }

for round in $(seq "$START_ROUND" "$MAX_ROUNDS"); do
  [ -f docs/ui-loop/STOP ] && { echo "STOP file found, ending." | tee -a "$LOG"; break; }
  echo "=== round $round: Codex builds ($(date +%H:%M)) ===" | tee -a "$LOG"
  cat > "$OUT/codex-$round.txt" <<EOF
You are Codex, the UI implementer in the Adam UI loop. Read docs/ui-loop/BATON.md first, then REBUILD_BRIEF.md, LAYOUT_STUDY.md and and your own notes from the previous round. Implement the next concrete slice of the UI rebuild in the SwiftUI app (OxyApp/OxyApp). Build with xcodebuild for the iPhone 17 Pro simulator (0104D694-28F4-4A20-A8A8-D601F55FB583), capture the screens you changed into docs/ui-loop/shots/ named loop${round}-*.png, and LOOK at them. Fix anything that looks wrong before finishing. Rules: never user123, explicit git add paths, no new settings, no SF Symbols, plain words, no Co-Authored-By trailer, xcodebuild clean before committing. npm test is NOT needed for Swift-only changes, so commit as soon as the build is clean. Commit your work on main. Finally, append a short entry to docs/ui-loop/BATON.md saying what you changed and which screens are next, and report your model and usage-limit status honestly. This is round ${round} of ${MAX_ROUNDS}.
EOF
  "$CODEX" exec -s workspace-write -c approval_policy=never - < "$OUT/codex-$round.txt" > "$OUT/codex-$round.log" 2>&1
  tail -5 "$OUT/codex-$round.log" >> "$LOG"
  if limit_hit "$OUT/codex-$round.log"; then echo "Codex reported a usage limit; pausing the loop." | tee -a "$LOG"; break; fi

done
echo "=== loop finished ($(date +%H:%M)) ===" | tee -a "$LOG"
