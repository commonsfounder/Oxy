# UI core pass: wheel, Activity, Memory, Today, Settings (You, Apps, Account), Your home

Device: iPhone 17 simulator, sample-data session, dark app. Screenshots are in docs/ui-loop/shots/swarm/ and start with `core-`.
No crashes. Log noise only: haptics file missing (simulator), and one real SwiftUI warning: "Bound preference ChatBottomDistanceKey tried to update multiple times per frame" (chat bottom distance, runs when the chat resizes).
Not tested: pull to refresh (no refresh surface found), Support/Privacy/Terms external links (would leave the app), Sign out buttons.

## Severity 3

[3] Typing on the Memory screen goes into the hidden chat box behind it. After "Ask Adam about this" leaves the keyboard up, then opening the wheel and Memory, "Remember something" opens an unfocused field and anything typed ("zzzz") lands in the chat composer. It showed up later in the chat as "...council bill?zzzz".
Screen: Memory. Shots: core-memory.png, core-memory-search-empty.png, core-after-memory-close.png.
Why: the user types into nothing, sees no text, then finds stray letters in chat.
Fix: in the Memory view, focus the "Remember that..." field when it expands (@FocusState set on expand). Also drop chat composer focus when the wheel opens (ChatView composer / wheel presenter).

[3] Adam's replies do not grow with the largest text size, while the user's bubbles, chips and timestamps do. Adam's text stays tiny next to huge "yes". Screen: chat at accessibility-extra-extra-extra-large. Shot: core-xxxl-chat.png.
Why: the main reading text ignores the user's text size; it looks broken and fails accessibility.
Fix: the assistant bubble font should use a Dynamic Type style (Views/Chat message bubble view); likely a fixed `.system(size:)`.

[3] Connected apps cannot be opened or disconnected, yet the footer says "You can disconnect an app at any time." Screen: Settings > Apps. Shots: core-apps-gmail.png, core-apps-bottom.png.
Why: a direct promise with no way to keep it. Trust problem for an app that holds Gmail and Telegram.
Fix: make Connected rows tappable (detail with "Disconnect"), or remove the promise. AppsView / connected row.

[3] Saved logins is a dead end when Face ID is unavailable: only "Unlock", which does nothing, with a hollow blue circle as the lock icon. Screen: Settings > Apps > Saved logins. Shots: core-saved-logins.png, core-saved-logins2.png.
Why: no passcode fallback, no explanation, no way forward.
Fix: fall back to device passcode (LAContext .deviceOwnerAuthentication) and use a real lock icon. SavedLoginsView.

[3] "Session expired" is shown with "Try again" and a Wi-Fi icon, but trying again cannot fix a sign-in problem and there is no sign-in button. Seen in chat, Payment methods, Export. Shots: core-after-memory-close.png, core-payments.png, core-export.png.
Why: user is stuck in a loop. The Wi-Fi icon says "offline", which is wrong.
Fix: for auth errors show "Sign in" that opens the sign-in sheet and use a lock/person icon. Shared error banner (the component with the Wi-Fi glyph and white "Try again" pill).

[3] The Export error appears at the very bottom, inside the "Sign out and delete" card under Delete account, far from the Export row. Screen: Settings > Account. Shot: core-export.png.
Why: it reads as a problem with deleting or signing out, and can be off screen on small phones.
Fix: put the message directly under "Export my data" (AccountView).

[3] The Displays screen shows an internal old-brand address to users: "open milgrain-live-2026.fly.dev/display". Shot: core-displays.png.
Why: wrong brand, looks like a developer build, impossible to type on a TV.
Fix: use the real short domain (e.g. adam.app/display) from config; DisplaysView.

## Severity 2

[2] The first launch gave a blank white screen for over 25 seconds, then nothing; a second launch worked at once. Screen: cold start. Shots: none usable (white).
Why: first impression is a white screen, no logo.
Fix: add a launch screen in the app's dark colour with the A mark; check what blocks the first frame (autologin / preview data load).

[2] Facts contradict each other: Apps says Gmail and Google are Connected, but Chat says "Gmail isn't connected" and Activity says "Google is not connected". Shots: core-apps.png, core-activity-all.png.
Why: user cannot tell what Adam can actually do.
Fix: make PreviewData consistent; in the real app make the apps list read live status.

[2] Screen titles sit at different heights. Activity's title is about 25pt lower than Memory, Today, Settings and Your home; sub screens use a back chevron plus a lower title, with no X. Shots: core-activity-all.png vs core-memory.png.
Why: title jumps as you move between wheel screens; feels unfinished.
Fix: one shared header component with the same top padding (Activity header in Views/Activity).

[2] Back chevron is a tiny bare glyph (about 14pt) in the top left. Tap area looks well under 44pt. Seen on every sub screen. Shot: core-settings-you.png.
Fix: 44x44 hit area and a visible round button like the X.

[2] Content scrolls up under the title and is cut by a hard line, with no fade, so words are sliced ("What Adam knows", "You" radar card). Shots: core-memory-scrolled.png, core-settings-you-bottom.png.
Fix: add a gradient mask or background behind the title row.

[2] The keyboard stays up everywhere. Scrolling does not close it, and it follows the user across the wheel and Memory. Shots: core-wheel-after-kb.png, core-memory.png.
Fix: .scrollDismissesKeyboard(.interactively) and resign focus when the wheel opens.

[2] Today cards: a white pill sits inline in a sentence, so wrapped lines start under the pill at the card edge on cards with no icon and under the icon text on cards with an icon. Only some cards have logos. The dismiss "x" is a small grey mark with no feedback or undo. Shots: core-today.png, core-today-dismiss.png.
Fix: put the verb pill on its own line or align wrapped text to the text column; give every card an icon or none; 44pt x target with an Undo toast. TodayCardView.

[2] Home address "Save" is the bright primary button while the field is empty, and it does nothing when tapped (Find does nothing too). Shots: core-home-save-empty.png, core-home-find-empty.png.
Fix: disable and dim Save until text exists, make Find the primary, show a hint when tapped empty. HomeAddressView.

[2] Apps list errors show as a small grey line at the top that pushes the whole list down 36pt, not in the error colour, away from the tapped button. Shots: core-apps-connect-sheet.png, core-apps-whatsapp.png.
Fix: show the message under the row that failed, in the same style as other errors.

[2] Error styles are inconsistent: red text ("Couldn't save that."), grey banner with white pill (Try again), tinted pill with orange outline (chat), grey line (Apps). The error stays after the user keeps going (Memory). Shots: core-memory-saved.png, core-payments.png, core-after-memory-close.png.
Fix: one error component; clear on edit.

[2] Large text: the error banner shrinks to its text and is narrower than the cards below it. Chat error pill is narrower than the composer even at normal size. Shot: core-xxxl-yourhome.png, core-closed-settings.png.
Fix: frame(maxWidth: .infinity) on the banner and the chat error pill.

[2] The card sheet ("Card for checkout") uses plain iOS grey and system-blue Cancel while everything else is navy; the Delete account alert also has iOS-blue Cancel. Edit Memory sheet is navy. Shots: core-payments-add.png, core-delete-account.png, core-memory-row.png.
Fix: theme the sheets and alerts the same way (tint, background).

[2] Delete account: one tap on a red "Delete" after a short alert; Cancel and Delete have equal weight. Shot: core-delete-account.png.
Fix: make the user type "delete" or hold to confirm for a permanent action; keep Cancel as the default.

[2] App logos are inconsistent: Gmail, Outlook, Telegram, Zoom sit on white tiles; WhatsApp, Pinterest, Discord, Reddit, Slack, Facebook are bare logos of different sizes. Shots: core-apps.png, core-apps-bottom.png.
Fix: put every logo on the same rounded tile.

[2] Activity wording: "Waiting on you" and "Coming up" are section names, and "Coming up" is also a filter that contains a "Waiting on you" section. Row labels "Did / Checked / Noticed / Asked you / Scheduled" read like log entries, "Every Friday Morning" has a stray capital, "Couldn't finish" repeats "Couldn't read your calendar". Times like 18:33 and 21:33 sit under "Yesterday" with no day so order looks wrong. "Done" shows only one of four "Recently" items. Shots: core-activity-all.png, core-activity-coming.png.
Fix: rename filter to "Upcoming" or drop the duplicate section title; sentence-case the repeat text; give each row a date.

[2] Account screen: "Account ID" shows an email in a monospace font (not an ID); the old "oxy.app" domain shows. "Privacy Policy" and "Terms of Use" use Title Case while everything else uses sentence case. Row "Import from ChatGPT or Claude" opens a screen titled "Import your chats". Shots: core-account.png, core-import.png.
Fix: label it "Email"; sentence case; match titles.

[2] Import screen uses file jargon (".zip export. A .json includes conversations only.") and a big primary "Choose export" with no help on how to get an export. Shot: core-import.png.
Fix: plain words and a "How do I get this?" link.

[2] You screen: "Add your name" is large bold sans in bright blue, a different voice from the serif titles, and does not look editable. The sample content ("People: Your supplier", "Communication style: Direct" followed by "You prefer direct communication") repeats itself. Settings > You > Memory duplicates the wheel's Memory. Shots: core-settings-you.png, core-settings-you-bottom.png.

[2] Settings has a floating A logo labelled "Advanced". It does not look tappable and the word means nothing to a normal user. The screen behind it has only an error and "Version adam-0001-alpha". Shots: core-settings.png, core-settings-advanced.png.
Fix: a normal row at the bottom named "About" or hide until there is content; no raw build string.

## Severity 1

[1] The wheel only shows 4 of 5 items; "Your home" is hidden and nothing hints that it spins. Blurry grey glow blobs drift in the background and look like smudges. Shots: core-wheel-after-kb.png, core-wheel-spin.png.
Fix: show a small hint or peek of the fifth item; remove or tone down blobs.

[1] "Ask Adam about this" fills the chat box with "Tell me more about: Pay the £84 council bill?" instead of sending, and it is a dark button on a dark card with low contrast. Shots: core-activity-rowtap.png, core-activity-ask.png.
Fix: send directly or use plain words ("What do I need to do about this?"); lighter button.

[1] Home address and other fields jump about 4pt when the keyboard focuses; composer placeholder sits higher than the + after changing text size. Shot: core-home-find.png, core-light-chat.png.

[1] Opening a "Waiting on you" item offers only "Ask Adam about this"; there are no Pay or Skip actions. The Edit Memory sheet has no Delete even though Memory says "See, correct or delete anything". Shots: core-activity-rowtap.png, core-memory-row.png.

[1] Straight quotes and apostrophes ("switch to night", "Couldn't") in most places but curly ones in Displays ("Couldn’t"). Shots: core-settings.png, core-displays.png.

[1] Memory: three phrasings for one action ("Remember something...", heading "Remember", "Add it once. It's kept for later.", placeholder "Remember that..."); "3 memories" count while "From your photos" adds another note. Shot: core-memory-remember.png.

[1] Light mode: the app stays dark, which is fine, but the status bar and keyboard follow the system, so there is a mismatch only on the keyboard (light/dark). Shot: core-light-chat.png.

[1] Edge swipe back works from sub screens. Wheel items, X buttons and filters all respond. Double taps on Connect and back were safe.
