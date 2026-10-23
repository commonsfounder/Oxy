#!/bin/bash
# Codex builds the UI, Claude critiques it, repeat, with no human in between.
# Stops after MAX_ROUNDS, when docs/ui-loop/STOP exists, or when either side reports a usage limit.
# Usage: scripts/ui-loop.sh [rounds]   (log: /tmp/ui-loop.log)

set -u
cd "$(dirname "$0")/.." || exit 1
MAX_ROUNDS="${1:-4}"
CODEX="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
LOG=/tmp/ui-loop.log
OUT=/tmp/ui-loop
mkdir -p "$OUT"
: > "$LOG"

limit_hit() { grep -qiE "usage limit|rate limit|quota|try again (at|in)" "$1"; }

for round in $(seq 1 "$MAX_ROUNDS"); do
  [ -f docs/ui-loop/STOP ] && { echo "STOP file found, ending." | tee -a "$LOG"; break; }
  echo "=== round $round: Codex builds ($(date +%H:%M)) ===" | tee -a "$LOG"
  cat > "$OUT/codex-$round.txt" <<EOF
You are Codex, the UI implementer in the Adam UI loop. Read docs/ui-loop/BATON.md first, then REBUILD_BRIEF.md, LAYOUT_STUDY.md and (from round 2 on) the latest docs/ui-loop/CLAUDE_REVIEW_*.md. Implement the next concrete slice of the UI rebuild in the SwiftUI app (OxyApp/OxyApp). Build with xcodebuild for the iPhone 17 Pro simulator (0104D694-28F4-4A20-A8A8-D601F55FB583), capture the screens you changed into docs/ui-loop/shots/ named loop${round}-*.png, and LOOK at them. Fix anything that looks wrong before finishing. Rules: never user123, explicit git add paths, no new settings, no SF Symbols, plain words, no Co-Authored-By trailer, xcodebuild clean before committing. Commit your work on main. Finally, append a short entry to docs/ui-loop/BATON.md saying what you changed and which screens are next, and report your model and usage-limit status honestly. This is round ${round} of ${MAX_ROUNDS}.
EOF
  "$CODEX" exec -s workspace-write -c approval_policy=never - < "$OUT/codex-$round.txt" > "$OUT/codex-$round.log" 2>&1
  tail -5 "$OUT/codex-$round.log" >> "$LOG"
  if limit_hit "$OUT/codex-$round.log"; then echo "Codex reported a usage limit; pausing the loop." | tee -a "$LOG"; break; fi

  echo "=== round $round: Claude reviews ($(date +%H:%M)) ===" | tee -a "$LOG"
  cat > "$OUT/claude-$round.txt" <<EOF
You are Claude, the critic in the Adam UI loop. Do NOT edit app code. Read docs/ui-loop/BATON.md and look at the newest docs/ui-loop/shots/loop${round}-*.png images yourself. Judge them against REBUILD_BRIEF.md and the seven references in docs/ui-loop/shots/research. Write docs/ui-loop/CLAUDE_REVIEW_${round}.md: a hard, specific critique in the format from docs/UI_LOOP.md, ranked by severity, saying what a first-time user would hate, plus what is good. Be honest, not polite. Then commit only that file. End by stating your model and any usage-limit concern.
EOF
  claude -p --model sonnet --permission-mode acceptEdits --allowedTools "Read,Write,Bash(git add docs/ui-loop/*),Bash(git commit:*),Bash(git status:*),Bash(git log:*),Bash(ls:*)" < "$OUT/claude-$round.txt" > "$OUT/claude-$round.log" 2>&1
  tail -5 "$OUT/claude-$round.log" >> "$LOG"
  if limit_hit "$OUT/claude-$round.log"; then echo "Claude reported a usage limit; pausing the loop." | tee -a "$LOG"; break; fi
done
echo "=== loop finished ($(date +%H:%M)) ===" | tee -a "$LOG"
