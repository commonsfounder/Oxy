# Putting Cloudflare in front of Fly

Cloudflare sits between visitors and the Fly app: it adds bot and attack protection and caching, and the app itself stays on Fly. Nothing moves.

## What is already done in code
- `api/services/client-ip.js`: behind Cloudflare, Fly only sees Cloudflare's address. With `OXY_TRUST_CLOUDFLARE=on` the app reads the real visitor address from `CF-Connecting-IP`, but only when the connection really came from a Cloudflare address, so a forged header does nothing. Without it, every visitor would share one rate limit.
- Off by default, so nothing changes until the steps below are done.

## Steps (in this order)
1. **Domain.** Pick the address the app will live on (for example `api.yourdomain.com`). It must be a domain you own.
2. **Add the domain to Cloudflare** (free plan is enough) and change the domain's nameservers at the registrar to the two Cloudflare gives you. Wait until Cloudflare shows it as active.
3. **Fly certificate:** `fly certs add api.yourdomain.com --app milgrain-live-2026`. Fly prints the DNS record it wants.
4. **Cloudflare DNS:** add a `CNAME` for `api` pointing to `milgrain-live-2026.fly.dev`. Turn the orange cloud (proxy) **on** only after `fly certs show api.yourdomain.com --app milgrain-live-2026` says the certificate is issued.
5. **Cloudflare SSL/TLS mode:** set to **Full (strict)**.
6. **Tell the app:** `fly secrets set OXY_TRUST_CLOUDFLARE=on APP_URL=https://api.yourdomain.com --app milgrain-live-2026`, then deploy.
7. **Update everything that points at the old address:**
   - iOS app: `OxyApp/OxyApp/Services/APIClient.swift` (lines 34 and 36) still hard-code `milgrain-live-2026.fly.dev`. Ship an app update; keep the old address working until everyone has it.
   - Webhooks registered with other services (Telegram bot, Twilio, Stripe, OAuth redirect URLs for Google and others) must be re-registered to the new address.
8. **Check:** `curl -I https://api.yourdomain.com/health` shows a `cf-ray` header, and `/version` still answers.

## Cloudflare settings worth turning on
- Bot Fight Mode (free) and a rate-limiting rule on `/chat`.
- Leave caching off for the API (`Cache Level: Bypass` for `/*`); only cache static pages if you add any.
- WebSockets are supported (live browser view, display connection).

## Rolling back
Switch the orange cloud off in Cloudflare DNS, or point the iOS app back at the `fly.dev` address. The origin never stopped working.
