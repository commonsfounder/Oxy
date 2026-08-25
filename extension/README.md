# Oxy session share

Hands Oxy the login you already have in Chrome for one site, so the agent arrives signed in
instead of facing a login wall, 2FA, and bot detection as a brand-new visitor. Oxy never
learns the password, because it never signs in.

## Why an extension and not a script

`scripts/import-chrome-session.js` does the same job from the terminal, but macOS fences off
`~/Library/Application Support/Google/Chrome`. Reading the cookie file needs Full Disk
Access, which is a far broader grant than "share one shop". Chrome's own cookies API has no
such restriction, so the extension needs no system-level permission at all.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked**, and choose this `extension/` folder

No store listing, no review, no Apple developer account.

## Get a token

The extension needs an Oxy session token once. This reads the password without echoing it,
so it never lands in shell history or `ps` output, and prints only the token:

```
node scripts/oxy-token.js <your-user-id> | pbcopy
```

## Use

1. Sign in to the site in Chrome as normal
2. Click the extension while on that site
3. Paste your Oxy token once (it is remembered only after a request succeeds with it)
4. **Share session**

Chrome asks for permission for that one site, at that moment. The site is taken from the tab
you are on and is never typed, so there is no way to mistype a domain and share the wrong
site's cookies.

## What it does not do

- It has no standing access to any site. Permission is requested per site, per share.
- It only ever reads the site you are sharing.
- Oxy filters again on its side and drops anything not belonging to that site, so a mistake
  here cannot become a stored session for somewhere else.
- Finance and identity sites are refused outright by the server, not merely permissioned.
- A shared session expires on its own after two weeks and can be revoked at any time.
