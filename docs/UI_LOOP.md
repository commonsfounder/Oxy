# UI loop: Claude and Codex, taking turns

Chizi wants the app's UI to get properly good, and has asked Claude and Codex to work on it together. The rules below keep us out of each other's way and keep the critique honest. Chizi's standing bar still applies: ordinary people, plain words, one control per idea, nothing added without asking.

## The loop

1. **Look.** Every round starts with screenshots of the real screens (see "Seeing the app"). No critique from code alone.
2. **Critique, hard.** The reviewer writes what a first-time user would hate. Be specific and unkind to the design, not the person: what is ugly, confusing, cramped, inconsistent, dead or pointless. Rank by severity.
3. **Fix.** The other agent picks the worst items and changes the code, one small commit per fix.
4. **Look again.** Screenshot the same screens. If it isn't visibly better, it isn't done.
5. **Swap.** The reviewer becomes the coder next round and the coder becomes the reviewer.

`docs/ui-loop/BATON.md` says whose turn it is and what is queued. Update it when you hand over.

Chizi's selected reference images and intent are recorded in [ui-loop/VISUAL_REFERENCES.md](ui-loop/VISUAL_REFERENCES.md). Inspect the images directly and form an independent opinion. Claude and Codex are peers, not each other's instructor; turn-taking coordinates edits, not authority over taste. Discuss disagreements using concrete screenshots. Borrow selected qualities rather than copying a whole app, and distinguish agent interpretation from Chizi's visual approval.

## Critique format (copy this)

```
### <screen>  (screenshot: shots/<file>.png)
- [severity 1-3] What is wrong, in a sentence a user would say out loud.
  Why it hurts: ...
  Fix: ...
```
Severity 3 = users would leave or be confused. 2 = looks cheap or inconsistent. 1 = polish.
Also list "decisions I would question" (product choices, not pixels) separately, for Chizi.

## Seeing the app

- Simulator, signed in with **Continue as Test User** (debug builds only). That session answers from `OxyApp/OxyApp/Services/PreviewData.swift`, so screens show realistic sample data and touch no account. Add fixtures there when a screen needs data to be judged.
- Set the look Chizi uses: `xcrun simctl spawn <device> defaults write ai.oxy.app adam_thread_background night`.
- Launch: `SIMCTL_CHILD_OXY_DEBUG_AUTOLOGIN=1 xcrun simctl launch <device> ai.oxy.app`.
- Capture: `xcrun simctl io <device> screenshot docs/ui-loop/shots/<name>.png`.
- The real phone only gets a build once the simulator looks right.

## Rules

- Never run tests, scripts or chats as `user123`: that is Chizi's real account.
- Stage explicit paths; both of us commit to `main`, so check `git status` first and never take the other's uncommitted work.
- No new settings, switches or screens without Chizi saying yes. Prefer deleting things.
- No SF Symbols. Real icons only. No tiny uppercase labels, no cards inside cards.
- `npm test` green before a commit that touches the API. `xcodebuild` clean before one that touches the app.

## Auto-looping, and being partners

Both agents loop on their own, so the loop runs as a back-and-forth with no human in between. After a turn, hand over through `docs/ui-loop/BATON.md` and, when you can, wake the other one (`codex exec` for Claude to reach Codex). When it matters, say which model you are and what your usage limits look like, and agree out loud when to pause until a limit resets. Log those exchanges in BATON.md under "Partner notes". Chizi's domain is heyintuitive.com; do not point the app at it until it serves the display page.
