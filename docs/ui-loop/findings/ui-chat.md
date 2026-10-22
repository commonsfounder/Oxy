# Chat screen findings (iPhone 17e, sample session, dark appearance)

Screenshots are in /Users/chizigamonyewuchi/Documents/Oxy/docs/ui-loop/shots/swarm/. Views live under /Users/chizigamonyewuchi/Documents/Oxy/OxyApp/OxyApp/Views/Chat.

Not tested: real software keyboard (the simulator was using the hardware keyboard, so no keyboard appeared), microphone button, drag-to-dismiss keyboard, Files picker, empty state, tapping links. Pasted emoji came through garbled (an artefact of the simulator paste tool, not the app).

## Issues

1. [3] The error says "Session expired. Please sign in again." but the only button is "Try again", which just fails again with the same message. There is no way to sign in from here.
   - Screen: chat after tapping "Yes please" or sending any message. Screenshot: chat-yes-after8s.png, chat-sent-long.png.
   - Why users hate it: they are stuck in a loop, told to do something the screen gives no way to do. Every send fails the same way.
   - Fix: when the error is an expired session, make the button "Sign in" and route to sign-in. Look for the error pill view and its retry action in Views/Chat.

2. [3] Sending a normal chat message pops a system "Adam would like to access your Contacts" prompt, right after the user hits send and before any answer.
   - Screen: chat just after send. Screenshot: chat-sent-long.png.
   - Why users hate it: a permission request out of nowhere reads as suspicious, and the user did not ask for anything about contacts. The wording ("native message and FaceTime handoffs") means nothing to them.
   - Fix: ask for Contacts only when the user first asks Adam to message or call someone, with a short explanation first.

3. [2] The same error pill appears twice: once in the thread under the last sent message, and again pinned above the composer.
   - Screen: chat after a second failed send. Screenshot: chat-sent-long.png, last frame in chat-light-axxxl.png.
   - Why users hate it: it looks like two separate failures, and the old one stays forever.
   - Fix: keep one error, tied to the failed message. Clear the pinned copy when retried or dismissed.

4. [2] The error pill is narrower than the message box (it stops at about 87% of the width, and the box goes to the right margin), and the "Try again" button crowds its right edge.
   - Screen: chat, any error. Screenshot: chat-yes-after8s.png.
   - Why: looks misaligned and unfinished.
   - Fix: make the pill full width with the same side margins as the composer.

5. [2] Largest text size: assistant bubbles do not scale at all, while the user's bubbles, timestamps and composer placeholder do. In the error pill, "Try again" overflows its white capsule.
   - Screen: chat at accessibility-extra-extra-extra-large. Screenshot: chat-light-axxxl.png.
   - Why: the person who turned text up to read Adam cannot read Adam's own replies (the replies are the content). It also looks broken.
   - Fix: use Dynamic Type styles (not a fixed size) for assistant bubble text; let the error button wrap or grow, or stack the button under the text at large sizes.

6. [2] Long-pressing a bubble puts the Reply / Copy / Show on display pills on top of the pressed bubble's first lines, so you cannot read the message you are acting on. The three pills are also squeezed together and overlap one another.
   - Screen: long-press on the "Tomorrow is light" bubble. Screenshot: chat-longpress.png.
   - Why: the message you picked is half hidden, and the pills look cramped.
   - Fix: place the pill row below the bubble when there is room (or above the reaction bar), and give the pills spacing. "Show on display" needs a plainer name for people who do not own a display.

7. [2] In the "+" menu, with private mode on, the row's ghost icon is almost invisible (dark on dark), and the label "Turn off private mode" wraps to two lines, making that row taller and unlike the other rows.
   - Screen: + menu while private. Screenshot: chat-plus-menu-private.png.
   - Why: the one row that matters right now looks disabled.
   - Fix: use the same light icon colour as the other rows; shorten the label to "Turn off private" or widen the menu.

8. [2] Private mode is hard to notice. The only signs are a small ghost on the top-right button and the placeholder "Private · not saved". The older saved conversation stays on screen unchanged, with the same background and no label.
   - Screen: chat in private mode. Screenshot: chat-private-on.png.
   - Why: a user can forget they are private (or think the old messages are private too). The message about what is saved is only in the sheet.
   - Fix: tint the background or composer border clearly, show a small "Private" tag above the composer, and start a clean thread while private is on.

9. [2] The "+" menu has no dimmed backdrop and does not cover the "Try again" button, which stays bright and tappable beside the menu.
   - Screen: + menu. Screenshot: chat-plus-menu-private.png.
   - Why: unclear what a tap outside does, and the menu looks pasted over the thread.
   - Fix: dim the thread while the menu is open, and put the menu above everything.

10. [2] When you scroll to the top of the thread there is a huge empty gap (about 300 pt) above the first timestamp.
    - Screen: thread top. Screenshot: chat-top.png .
    - Why: looks like the screen is missing content or still loading.
    - Fix: reduce the top inset of the message list; keep just enough room under the A button.

11. [1] After sending, the newest message is partly tucked behind the composer and fade (the sent bubble touches the box), and the thread does not settle with the last message clearly above the box.
    - Screen: chat after send. Screenshot: chat-private-on.png and the scroll frames.
    - Why: small, but the last thing said is the thing you want to see.
    - Fix: add bottom content inset equal to composer height plus about 16 pt, and scroll to it after send.

12. [1] The Private mode sheet has a large empty block between the last paragraph and "Got it", and the title is serif while the body is sans. It reads well otherwise.
    - Screen: Private mode sheet. Screenshot: shown in run (chat-private-on.png after dismissal).
    - Fix: size the sheet to its content.

13. [1] The "Photos & Videos" picker shows a spinner labelled "Loading..." on a black sheet for 3+ seconds before photos appear, with only an X to leave. After picking, the sheet closes and a "Photo — Ready for analysis" chip appears (clear and good), but the wording "Ready for analysis" is techy; "Photo added" is plainer.
    - Screenshot: chat-photos.png, chat-photo-picked.png.

14. [1] The wheel opened by the A button highlights "Activity" even though you are on Chat, and there is no item for Chat, so you cannot tell where you are. It closes cleanly with the X.
    - Screenshot: chat-wheel.png.
    - Fix: highlight the current screen or add a "Chat" item.

15. [1] Light appearance has no effect on the chat screen (stays dark). Fine if intentional; no change to confirm in the pack, but a user in light mode will see a dark app.
    - Screenshot: chat-light-axxxl.png.

## What worked
- Tapping "Yes please" sends the text immediately, the offer buttons disappear, and a stop square shows while sending.
- Long text, URL and an unbroken 80-character word wrap correctly in the composer (grows to about 5 lines then scrolls) and in the sent bubble.
- Camera and Photos open, close, and the attachment chip can be removed.
- Double tap on send sent only one message.
- No crashes in the app log. Log lines seen were normal system chatter.
