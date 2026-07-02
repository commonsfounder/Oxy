# Self-learning browser fast-paths — design (2026-07-01)

Follows the latency + cross-site work in `docs/BROWSER_TASK_SESSION_HANDOFF.md`. That work
proved a hand-written fast-path (jump straight to a site's search-results URL) turns a ~17s
multi-step task into a ~5s single-step one. This makes that registry **populate itself**: the
first time the agent searches a new site the slow way, it captures the site's search-URL
pattern and reuses it forever after. Plus a seed set of common UK sites so coverage is good on
day one.

## Goal
Turn `SEARCH_SITES` (currently 2 hand-written entries) into a self-growing registry, so repeat
visits to any site the agent has succeeded on before are fast — without hand-writing each one.

## Principle: learn the durable thing, not the fragile thing
- **Learn:** URL patterns. "On `johnlewis.com`, searching `<term>` lands at
  `/search?search-term=<term>`." Stable across redesigns, no personal data.
- **Do NOT learn:** click sequences / CSS selectors. Auto-generated selectors break on any DOM
  tweak, and a half-working replay is *worse* than starting fresh (it acts confidently on the
  wrong page). Personalised flows (address, cart) are unsafe to replay.
- **The LLM vision loop is always the fallback.** A learned shortcut only ever *skips* work; if
  it's missing or stale, the agent does exactly what it does today. We can never get *stuck*
  because of a bad recipe — worst case is today's speed.

## How learning happens (no user demonstration needed)
The signal is already there. When the site is unknown, the agent manually searches: it `fill`s a
search box, submits, and the page navigates to a results URL **containing the search term as a
query parameter**. That URL *is* the template.

Detector (in the loop, after a successful action):
1. Track `lastFilledValue` (the text of the most recent `fill`).
2. After the resulting navigation, scan `page.url()`'s query params for one whose value equals
   `lastFilledValue` (decoded, case-insensitive).
3. If found: `host` + `param` + a template = the URL with that param's value replaced by a
   placeholder, path preserved. Record it.

This auto-captures both existing seeds (`?search-term=`, `?freeText=`) with zero site-specific
code, and every future site the same way.

**Privacy:** we store only the *template* (`…?search-term=<term>`), never the user's actual
search term. Patterns are generic and non-sensitive — hence stored globally (see storage).

## Storage — shared/global
Learned patterns benefit everyone and contain no private data, so they live in one shared store,
not per-user.
- Learned entries are written **at runtime by the server**, so a committed JSON file won't work
  (prod containers are read-only) — persistence must be in Supabase. Decision: **new table
  `browser_fastpaths`** (global, not user-scoped): `host` (PK), `url_template`, `param`,
  `success_count`, `fail_count`, `last_ok_at`, `created_at`. One small migration; clean
  upsert-by-host and self-heal counters. (Seeds stay in code; only *learned* rows need the DB.)
- **In-memory cache** so `directSearchUrl` stays synchronous: load all patterns into a `Map` on
  server boot (next to `primeWarmBrowser()`), update the Map when we learn one, refresh
  periodically. The DB is the durable backing; the hot path never awaits it.

## Self-heal / staleness
- When a pattern is used and the run succeeds (item found), `success_count++`, `last_ok_at` set.
- When a fast-path open yields the "blocked/empty shell" or the agent has to re-search from
  scratch anyway, `fail_count++`. After N consecutive fails (e.g. 3), **disable** the pattern
  (stop using it, keep the row) and fall back to normal open + re-learn. A redesigned site thus
  self-corrects within a few visits instead of staying broken.

## Seed set (ships in code, like today's `SEARCH_SITES`)
Bootstrap the common UK sites the user picked, each verified with the discover-URL harness
(`scratchpad/discover-search-url.js`) before adding:
- **Dept/fashion:** John Lewis ✓, Selfridges ✓, Next, ASOS, M&S, End Clothing.
- **Grocery:** Tesco, Sainsbury's, Ocado, Waitrose — verify each; some have heavy bot
  protection and get dropped if they don't load (a seed URL doesn't defeat a bot-wall).
Bot-walled sites (Argos, Just Eat) are intentionally excluded until a managed browser exists.

## Integration points (all in `api/services/browser-task.js`)
- `directSearchUrl(url, goal)` consults code seeds **then** the in-memory learned Map.
- A `learnFastpath(host, url, lastFilledValue)` helper called after successful search navigation.
- `recordFastpathOutcome(host, ok)` for self-heal counters.
- Boot: load the Map (extend `primeWarmBrowser` boot hook or add a sibling `primeFastpaths`).

## Verification
- Unit: detector (URL + filled value → template), template → URL round-trip, self-heal disable
  after N fails, cache precedence (seed vs learned). Extend `test/smoke/browser-latency.test.js`.
- E2E: pick a *fresh* non-seeded site, run once (learns), run again (should be 1-step fast).
  Confirm John Lewis/Selfridges unaffected.

## Out of scope
Full click-by-click replay; per-user recipes; selector learning; managed browser / bot-walled
sites; learning non-search flows (cart, address). Search-URL learning is ~all the payoff at
near-zero brittleness.
