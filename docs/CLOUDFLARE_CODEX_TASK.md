# Task for Codex: put Cloudflare in front of Fly for heyintuitive.com

You are working in /Users/chizigamonyewuchi/Documents/Oxy. Read docs/CLOUDFLARE.md first; it explains why. This file is the exact job. Chizi (the owner) is on their phone and logged in on this Mac. Use the browser (computer use) for dashboards and the shell for `fly` and `curl`.

Goal: `https://api.heyintuitive.com` serves the Adam backend through Cloudflare, with the Fly app `milgrain-live-2026` as the origin. The old address `https://milgrain-live-2026.fly.dev` must keep working the whole time.

## Rules (do not break these)
- Do NOT enter passwords, card numbers or 2FA codes. If a login or payment screen appears, stop and ask Chizi to do that part, then continue.
- Do NOT pay or edit Fly billing. Do NOT delete any DNS record, certificate, app or machine.
- Do NOT touch existing DNS records that are not yours (for example email MX/TXT records, or a website on the root domain). Only add the records named below.
- Do NOT turn the Cloudflare proxy (orange cloud) on before the Fly certificate is issued (step 4).
- Do NOT run `fly deploy` or `node scripts/deploy-fly.js`; Claude does the deploy once Fly is paid. You may set secrets only at step 7.
- Do NOT commit or push. Do not edit Swift files.
- If anything differs from this file (a screen, a message, a record that already exists), stop and tell Chizi in plain words before changing anything.

## Steps

1. **Find where heyintuitive.com is registered.** Run `whois heyintuitive.com` (or check https://lookup.icann.org). Note the registrar and the current nameservers. Report them. If the domain already uses Cloudflare nameservers (they end in `ns.cloudflare.com`), skip to step 3.

2. **Add the domain to Cloudflare.**
   - Open https://dash.cloudflare.com (Chizi logs in if needed; free plan).
   - "Add a domain" → `heyintuitive.com` → Free plan.
   - Cloudflare scans for existing DNS records. Keep every record it finds. Compare with the registrar's current DNS if you can see it; anything missing must be added so email and websites keep working.
   - Cloudflare shows two nameservers. At the registrar, replace the domain's nameservers with those two. (Chizi may need to log in to the registrar.)
   - Wait until Cloudflare shows the domain as **Active** (can take minutes to hours). Check with `dig NS heyintuitive.com +short`.

3. **Fly certificate.** Run `fly certs add api.heyintuitive.com --app milgrain-live-2026`. It prints the DNS record Fly wants (a CNAME to `milgrain-live-2026.fly.dev`, sometimes also an `_acme-challenge` CNAME). Copy exactly what it says.

4. **DNS in Cloudflare (proxy OFF for now).**
   - Add `CNAME` name `api` → target `milgrain-live-2026.fly.dev`, **Proxy status: DNS only (grey cloud)**.
   - Add the `_acme-challenge` record too if Fly asked for it (DNS only).
   - Run `fly certs show api.heyintuitive.com --app milgrain-live-2026` every minute or two until it says the certificate is **Issued**. Then, and only then, edit the `api` record and switch it to **Proxied (orange cloud)**.

5. **Cloudflare settings.**
   - SSL/TLS → Overview → encryption mode **Full (strict)**.
   - SSL/TLS → Edge Certificates → "Always Use HTTPS" on.
   - Caching → Cache Rules: create a rule for hostname `api.heyintuitive.com` → **Bypass cache**.
   - Security → Bots: turn **Bot Fight Mode** on.
   - Network: confirm **WebSockets** is on.

6. **Check it works.**
   - `curl -sI https://api.heyintuitive.com/health` → 200 and a `cf-ray` header.
   - `curl -s https://api.heyintuitive.com/version` → JSON with `"flyApp":"milgrain-live-2026"`.
   - `curl -s https://milgrain-live-2026.fly.dev/version` still works.
   - Report all three results.

7. **Only after Chizi confirms Fly is paid and Claude has deployed the latest code** (ask first): run
   `fly secrets set OXY_TRUST_CLOUDFLARE=on APP_URL=https://api.heyintuitive.com --app milgrain-live-2026`
   then re-run the checks in step 6.

## When done, report in plain words
- Registrar and nameservers before and after.
- Which records you added in Cloudflare (list them).
- Results of the three checks.
- Anything you could not do and why.

## Not part of this task (Claude will handle after)
- Pointing the iPhone app at `api.heyintuitive.com` (needs an app update).
- Re-registering webhooks (Telegram, Twilio, Google sign-in redirect URLs) to the new address.
