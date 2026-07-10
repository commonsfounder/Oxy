# iOS Card-Linking UI + SCA Re-auth Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-shipped Stripe backend reachable from the iOS app: a Payments screen to link/replace/remove a card and see the concierge balance, and a Today banner that lets the user complete SCA/3DS re-authentication for a charge stuck in `requires_action`.

**Architecture:** Four small backend additions (one currency-threading fix, one new service function, four new REST routes) expose state the backend already tracks internally. On iOS: a new `PaymentsView` (mirroring the existing `ConnectorsView` list-screen pattern) drives Stripe's `PaymentSheet` for linking and a `DELETE` call for unlinking; a new `PaymentActionBanner` on the Today screen drives Stripe's `STPPaymentHandler` for the 3DS challenge. Both use the existing `APIClient.shared.request(...)` convention — no new networking abstraction.

**Tech Stack:** Node.js/Express (backend, already established), Swift/SwiftUI (iOS, already established), Stripe iOS SDK (`stripe-ios` via Swift Package Manager — first SPM dependency in this Xcode project), Stripe Node SDK (already a dependency, already used by `stripe-cards.js`).

## Global Constraints

- `npm test` must stay green before any commit (`CLAUDE.md`).
- Pushing to `origin/main` triggers the Cloud Run auto-deploy — a local commit alone does not deploy (`CLAUDE.md`). Push after each backend task so the iOS tasks can hit a live, updated backend.
- This repo has no HTTP-route test harness (no `supertest` anywhere in `test/` or `package.json`) — the two existing Stripe routes (`/connectors/stripe/setup-intent`, `/connectors/stripe/confirm`) have no dedicated route-level tests either. Follow that convention: put real test coverage on the underlying service functions in `api/services/stripe-cards.js`, and treat the route handlers themselves as thin wiring verified by manual/e2e checks.
- The iOS app (`OxyApp/`) has no XCTest target wired up for its services today. iOS task verification is manual: build in Xcode, run in the Simulator, exercise the flow. Use Stripe's test cards: `4242 4242 4242 4242` (clean link/charge, any future expiry, any CVC/ZIP) and `4000 0025 0000 3155` (forces `requires_action`, i.e. 3DS challenge).
- Concierge balance displays as a **plain formatted number**, never with a currency symbol (it's a virtual running ledger, not a currency-denominated Stripe object). Only real charges (the SCA banner) get currency-symbol formatting, via `NumberFormatter` with `.currency` style and the currency code the backend actually charged in.
- The Stripe iOS SDK is added via Xcode's own File → Add Package Dependencies UI — never hand-edit `OxyApp.xcodeproj/project.pbxproj` package references directly.

---

### Task 1: Thread currency through the parked-SCA-charge record

**Files:**
- Modify: `api/services/stripe-cards.js:102-109` (`setPaymentActionRequired`)
- Modify: `connectors/stripe.js:114-117` (`spend_from_concierge_via_stripe` action, in `execute()`)
- Modify: `api/index.js:2449-2453` (`spend_from_concierge_account` case)
- Modify: `api/index.js:2533-2536` (`stripe_charge` case)
- Test: `test/smoke/stripe-cards.test.js:198-207` (existing `payment-action-required set/get/clear round-trips` test)

**Interfaces:**
- Consumes: nothing new — this task only adds a field to data already flowing through `setPaymentActionRequired`/`getPaymentActionRequired` (both already exported from `api/services/stripe-cards.js`), and the existing `resolveCurrencyForLocation(location)` from `api/services/currency-from-location.js` (already wired into all three call sites' `chargeLinkedCard` calls as of the 2026-07-10 currency-mapping work).
- Produces: `getPaymentActionRequired(supabase, userId)` now resolves to an object that includes a `currency` field (e.g. `'gbp'`) alongside the existing `paymentIntentId`/`clientSecret`/`amountCents`/`description`/`createdAt`. Task 3's new `GET /connectors/stripe/payment-action` route, and Task 8's iOS banner, both depend on this field being present.

The pending-SCA record currently stores `amountCents` and `description` but not the currency the charge was actually attempted in — so nothing downstream can show "£25.00" instead of a bare "25.00" for a parked charge. Since the currency is already computed at each call site (via `resolveCurrencyForLocation`), this is just plumbing it one field further.

- [ ] **Step 1: Write the failing test**

Add this test right after the existing `payment-action-required set/get/clear round-trips` test (after line 207) in `test/smoke/stripe-cards.test.js`:

```javascript
test('payment-action-required round-trips the currency the charge was attempted in', async () => {
  const supabase = fakeSupabase();
  await setPaymentActionRequired(supabase, 'user-1', {
    paymentIntentId: 'pi_3', clientSecret: 'pi_3_secret', amountCents: 1200, description: 'y', currency: 'gbp'
  });
  const pending = await getPaymentActionRequired(supabase, 'user-1');
  assert.equal(pending.currency, 'gbp');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/stripe-cards.test.js`
Expected: FAIL — `pending.currency` is `undefined`, not `'gbp'` (the current `setPaymentActionRequired` doesn't store a `currency` field, so `assert.equal(undefined, 'gbp')` fails).

- [ ] **Step 3: Add `currency` to `setPaymentActionRequired`**

In `api/services/stripe-cards.js`, change the function signature and stored payload (currently lines 102-109):

```javascript
async function setPaymentActionRequired(supabase, userId, { paymentIntentId, clientSecret, amountCents, description, currency }) {
  await supabase.from('preferences').upsert({
    user_id: userId,
    key: PAYMENT_ACTION_REQUIRED_KEY,
    value: JSON.stringify({ paymentIntentId, clientSecret, amountCents, description, currency, createdAt: new Date().toISOString() }),
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,key' });
}
```

(`getPaymentActionRequired` needs no change — it already returns the full parsed JSON blob, so the new `currency` field passes through automatically.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/smoke/stripe-cards.test.js`
Expected: PASS (all tests in the file, including the new one and the pre-existing round-trip test, which still passes since it doesn't pass or assert on `currency`).

- [ ] **Step 5: Pass currency at all three call sites**

In `connectors/stripe.js`, the `spend_from_concierge_via_stripe` branch (currently lines 114-117) already has a `currency` local computed earlier in `execute()` (from Task work already merged: `const currency = resolveCurrencyForLocation(params?.location);`). Update the `setPaymentActionRequired` call:

```javascript
      if (outcome.status === 'requires_action') {
        await setPaymentActionRequired(supabase, userId, {
          paymentIntentId: outcome.paymentIntentId, clientSecret: outcome.clientSecret, amountCents, description: desc, currency
        });
```

In `api/index.js`, the `spend_from_concierge_account` case (currently lines 2449-2453) — the `currency` is currently computed inline inside the `chargeLinkedCard` call rather than stored in a variable. Refactor to a local so both call sites in this case share one computation, then pass it through:

```javascript
      const idempotencyKey = crypto.randomUUID();
      const currency = resolveCurrencyForLocation(context.location);
      const outcome = await chargeLinkedCard(stripeClient, supabase, userId, {
        amountCents: Math.round(amount * 100), currency, description: `${description} at ${merchant}`, idempotencyKey
      });

      if (outcome.status === 'no_card') {
        return { success: false, error: 'No card linked yet. Link a card in Payments settings to spend for real.' };
      }
      if (outcome.status === 'failed') {
        return { success: false, error: `Stripe charge failed, so nothing was spent: ${outcome.error}`, balance: balanceBeforeSpend };
      }
      if (outcome.status === 'requires_action') {
        await setPaymentActionRequired(supabase, userId, {
          paymentIntentId: outcome.paymentIntentId, clientSecret: outcome.clientSecret,
          amountCents: Math.round(amount * 100), description: `${description} at ${merchant}`, currency
        });
```

In `api/index.js`, the `stripe_charge` case (currently lines 2533-2536) — same refactor:

```javascript
      const idempotencyKey = crypto.randomUUID();
      const currency = resolveCurrencyForLocation(context.location);
      const outcome = await chargeLinkedCard(stripeClient, supabase, userId, {
        amountCents, currency, description: desc, idempotencyKey
      });

      if (outcome.status === 'no_card') {
        return { success: false, error: 'No card linked yet. Link a card in Payments settings to spend for real.' };
      }
      if (outcome.status === 'failed') {
        return { success: false, error: `Stripe charge failed, so nothing was spent: ${outcome.error}`, balance: balanceBeforeSpend };
      }
      if (outcome.status === 'requires_action') {
        await setPaymentActionRequired(supabase, userId, {
          paymentIntentId: outcome.paymentIntentId, clientSecret: outcome.clientSecret, amountCents, description: desc, currency
        });
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all tests pass (492 existing + 1 new = 493).

- [ ] **Step 7: Commit**

```bash
git add api/services/stripe-cards.js connectors/stripe.js api/index.js test/smoke/stripe-cards.test.js
git commit -m "feat: store the currency a parked SCA charge was attempted in"
```

---

### Task 2: Add `unlinkCard`

**Files:**
- Modify: `api/services/stripe-cards.js` (add function + export, after `saveLinkedCard` at line 49)
- Test: `test/smoke/stripe-cards.test.js` (add tests after the existing `saveLinkedCard` tests, i.e. after line 85)

**Interfaces:**
- Consumes: `readStripeTokens`/`writeStripeTokens` (both already defined at the top of `api/services/stripe-cards.js`, lines 5-25) — same helpers `saveLinkedCard` already uses.
- Produces: `unlinkCard(supabase, userId): Promise<void>`. Task 3's `DELETE /connectors/stripe/card` route depends on this exact name and signature.

- [ ] **Step 1: Write the failing tests**

Add these tests right after the `saveLinkedCard rejects missing customerId or paymentMethodId` test (after line 85) in `test/smoke/stripe-cards.test.js`. First, add `unlinkCard` to the destructured import at the top of the file (line 4):

```javascript
const { getLinkedCard, saveLinkedCard, unlinkCard, STRIPE_CONNECTOR_ID, getOrCreateStripeCustomer, createSetupIntentForUser, resolveOffSessionChargeOutcome, chargeLinkedCard, setPaymentActionRequired, getPaymentActionRequired, clearPaymentActionRequired } = require('../../api/services/stripe-cards');
```

Then add the tests:

```javascript
test('unlinkCard clears the card fields and disables the connector, but keeps the Stripe customer id', async () => {
  const supabase = fakeSupabase();
  await saveLinkedCard(supabase, 'user-1', { customerId: 'cus_1', paymentMethodId: 'pm_1', brand: 'visa', last4: '4242' });
  await unlinkCard(supabase, 'user-1');
  const card = await getLinkedCard(supabase, 'user-1');
  assert.equal(card, null, 'getLinkedCard must report no card once unlinked');
  const row = supabase._rows.find(r => r._table === 'connectors' && r.user_id === 'user-1');
  assert.equal(row.enabled, false);
  assert.equal(row.tokens.stripe_customer_id, 'cus_1', 'customer id survives so a relink reuses it instead of creating a duplicate');
  assert.equal(row.tokens.default_payment_method_id, '');
  assert.equal(row.tokens.card_brand, '');
  assert.equal(row.tokens.card_last4, '');
});

test('unlinkCard on a user with no connector row yet is a harmless no-op', async () => {
  const supabase = fakeSupabase();
  await assert.doesNotReject(() => unlinkCard(supabase, 'user-1'));
  assert.equal(await getLinkedCard(supabase, 'user-1'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/stripe-cards.test.js`
Expected: FAIL — `unlinkCard is not a function` (destructured as `undefined` from the module, which isn't callable).

- [ ] **Step 3: Implement `unlinkCard`**

In `api/services/stripe-cards.js`, add this function directly after `saveLinkedCard` (after line 49):

```javascript
async function unlinkCard(supabase, userId) {
  const { tokens } = await readStripeTokens(supabase, userId);
  await writeStripeTokens(supabase, userId, {
    ...tokens,
    default_payment_method_id: '',
    card_brand: '',
    card_last4: ''
  }, { enabled: false });
}
```

Add it to the `module.exports` block at the bottom of the file:

```javascript
module.exports = {
  STRIPE_CONNECTOR_ID,
  PAYMENT_ACTION_REQUIRED_KEY,
  readStripeTokens,
  writeStripeTokens,
  getLinkedCard,
  saveLinkedCard,
  unlinkCard,
  getOrCreateStripeCustomer,
  createSetupIntentForUser,
  resolveOffSessionChargeOutcome,
  chargeLinkedCard,
  setPaymentActionRequired,
  getPaymentActionRequired,
  clearPaymentActionRequired,
  claimPaymentActionRequired
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/smoke/stripe-cards.test.js`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass (493 from Task 1 + 2 new = 495).

- [ ] **Step 6: Commit**

```bash
git add api/services/stripe-cards.js test/smoke/stripe-cards.test.js
git commit -m "feat: add unlinkCard so a user can remove their linked Stripe card"
```

---

### Task 3: Add the four REST routes and push

**Files:**
- Modify: `api/index.js` (add routes after the existing `POST /connectors/stripe/confirm` route, currently ending at line 6999, before `module.exports = app;` at line 7001)

**Interfaces:**
- Consumes: `getLinkedCard`, `unlinkCard` (Task 2), `getPaymentActionRequired` (already imported at `api/index.js:84` — verify `unlinkCard` gets added to that same import line), `getPreferenceMap` (already used throughout `api/index.js`, e.g. line 2425), `requireSessionAuth` and `getAuthenticatedUserId` (both already used by the two existing Stripe routes at lines 6960-6999), `supabase` (module-level, already in scope at those routes).
- Produces: four HTTP endpoints the iOS app will call starting in Task 5:
  - `GET /connectors/stripe/card` → `{ card: { customerId, paymentMethodId, brand, last4 } | null }`
  - `DELETE /connectors/stripe/card` → `{ linked: false }`
  - `GET /connectors/stripe/payment-action` → `{ action: { paymentIntentId, clientSecret, amountCents, description, currency, createdAt } | null }`
  - `GET /concierge/balance` → `{ balance: number }`

- [ ] **Step 1: Update the stripe-cards import to include `unlinkCard`**

In `api/index.js:84`, change:

```javascript
const { createSetupIntentForUser, getLinkedCard, saveLinkedCard, readStripeTokens, chargeLinkedCard, setPaymentActionRequired } = require('./services/stripe-cards');
```

to:

```javascript
const { createSetupIntentForUser, getLinkedCard, saveLinkedCard, unlinkCard, readStripeTokens, chargeLinkedCard, setPaymentActionRequired, getPaymentActionRequired } = require('./services/stripe-cards');
```

- [ ] **Step 2: Add the four routes**

Insert this block in `api/index.js` immediately after the existing `POST /connectors/stripe/confirm` route (i.e. right after the closing `});` that currently sits at line 6999, before the blank line and `module.exports = app;`):

```javascript
app.get('/connectors/stripe/card', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const card = await getLinkedCard(supabase, userId);
    res.json({ card });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/connectors/stripe/card', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await unlinkCard(supabase, userId);
    res.json({ linked: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/connectors/stripe/payment-action', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const action = await getPaymentActionRequired(supabase, userId);
    res.json({ action });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/concierge/balance', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const prefs = await getPreferenceMap(userId);
    const balance = Number(prefs['concierge_account.balance'] || 0);
    res.json({ balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all 495 tests still pass (this task adds route wiring only, no new unit-testable logic — consistent with how the two pre-existing Stripe routes have no dedicated tests either, per the Global Constraints note on this repo's testing convention).

- [ ] **Step 4: Manually sanity-check the routes respond**

This repo has no local dev-server convention documented for ad-hoc curl checks against Supabase-backed routes, so skip manual curl testing here — the routes will get their first real exercise from the iOS app in Tasks 5-8, against the deployed backend. Move straight to commit + push.

- [ ] **Step 5: Commit and push**

```bash
git add api/index.js
git commit -m "feat: expose linked-card, unlink, payment-action, and balance as REST routes"
git push origin main
```

This push triggers the Cloud Run auto-deploy — wait for it to complete (or check `gcloud` build logs per the `gcloud-deploy-access` memory) before starting Task 5, since the iOS work depends on these routes being live.

---

### Task 4: Add the Stripe iOS SDK and the Payments nav entry

**Files:**
- Modify: `OxyApp/OxyApp.xcodeproj` (via Xcode UI — add Swift Package dependency, no manual file edits)
- Modify: `OxyApp/OxyApp/Views/MainTabView.swift:145` (add `.payments` case) and `:302` (add menu row)
- Create: `OxyApp/OxyApp/Views/Payments/PaymentsView.swift` (placeholder for now — filled in by Task 5)

**Interfaces:**
- Consumes: `AppRow` (`OxyApp/OxyApp/Extensions/AppTheme.swift:976`), `ScreenHeaderView` (`OxyApp/OxyApp/Views/Components/ScreenHeaderView.swift`) — both already used identically by `ConnectorsView.swift`.
- Produces: `MainTabView.MoreDestination.payments` case and a `PaymentsView` type that Task 5 fills in. Later tasks (5-7) all build inside this same `PaymentsView.swift` file.

- [ ] **Step 1: Add the Stripe iOS SDK package dependency**

In Xcode: open `OxyApp/OxyApp.xcodeproj`. File → Add Package Dependencies... In the search field, enter `https://github.com/stripe/stripe-ios`. Select "Up to Next Major Version" starting from the latest stable release Xcode resolves. When the product picker appears, check **`StripePaymentSheet`** only (it transitively pulls in `StripeCore`, `StripePayments`, and `StripePaymentsUI` — the four modules this feature needs: `PaymentSheet` for linking, `STPPaymentHandler`/`STPAuthenticationContext` for the SCA challenge). Add it to the `OxyApp` target. Click "Add Package".

- [ ] **Step 2: Verify the project still builds**

In Xcode: Product → Build (⌘B) on the `OxyApp` scheme.
Expected: build succeeds with no errors. (No code uses the new package yet — this step only confirms the dependency resolved and links cleanly.)

- [ ] **Step 3: Create a placeholder `PaymentsView`**

Create `OxyApp/OxyApp/Views/Payments/PaymentsView.swift`:

```swift
import SwiftUI

struct PaymentsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()
                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Payments", onBack: { dismiss() })
                    Spacer()
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
    }
}

#Preview {
    PaymentsView()
        .environment(AppState())
}
```

- [ ] **Step 4: Wire up the `.payments` destination in `MainTabView`**

In `OxyApp/OxyApp/Views/MainTabView.swift:145`, change:

```swift
    enum MoreDestination: Identifiable {
        case profile, pendant, connectors, memory, settings
        var id: String { "\(self)" }
    }
```

to:

```swift
    enum MoreDestination: Identifiable {
        case profile, pendant, connectors, memory, settings, payments
        var id: String { "\(self)" }
    }
```

In the `switch dest` block (currently lines 181-187), add the new case:

```swift
                    case .profile: ProfileView()
                    case .pendant: PendantStatusView()
                    case .connectors: ConnectorsView()
                    case .memory: MemoryView()
                    case .settings: SettingsView()
                    case .payments: PaymentsView()
```

In the `menuSection`'s "Milgrain" group (currently lines 292-303), add a row after the existing "Connections" row:

```swift
            menuGroup("Milgrain") {
                AppRow(title: "Pendant", subtitle: "The piece you wear", onTap: { destination = .pendant }) {
                    HStack(spacing: 8) {
                        AppStatusDot(kind: pendantDot, diameter: 5)
                        if let s = pendantStatusText {
                            Text(s).font(.rowSecondary).foregroundStyle(Color.appMuted)
                        }
                    }
                }
                rowDivider
                AppRow(title: "Connections", subtitle: "Apps and services I can use") { destination = .connectors }
                rowDivider
                AppRow(title: "Payments", subtitle: "Your linked card and balance") { destination = .payments }
            }
```

- [ ] **Step 5: Manually verify the row navigates**

In Xcode: run the app in the Simulator (any signed-in test account). Go to the More tab → tap "Payments".
Expected: the placeholder screen appears with a "Payments" header and a working back chevron.

- [ ] **Step 6: Commit**

```bash
git add OxyApp/OxyApp.xcodeproj OxyApp/OxyApp/Views/MainTabView.swift OxyApp/OxyApp/Views/Payments/PaymentsView.swift
git commit -m "feat: add Payments screen shell and Stripe iOS SDK dependency"
```

---

### Task 5: Payments screen — balance + card display (read-only)

**Files:**
- Modify: `OxyApp/OxyApp/Views/Payments/PaymentsView.swift` (replace the placeholder body from Task 4)

**Interfaces:**
- Consumes: `APIClient.shared.request(path:method:body:queryItems:) async throws -> Data` (`OxyApp/OxyApp/Services/APIClient.swift:49`), `ErrorBanner` (`OxyApp/OxyApp/Views/Components/ErrorBanner.swift`), `OxySkeletonCard` (`OxyApp/OxyApp/Views/Components/LoadingIndicator.swift:56`), `AppSectionHeader` (`OxyApp/OxyApp/Extensions/AppTheme.swift:292`), the three GET routes from Task 3 (`GET /connectors/stripe/card`, `GET /connectors/stripe/payment-action` — not used yet, that's Task 8 — and `GET /concierge/balance`).
- Produces: `PaymentsView`'s `LinkedCard` and this task's loading state, which Task 6 (linking) and Task 7 (unlinking) both extend in the same file.

- [ ] **Step 1: Replace `PaymentsView.swift` with the loading screen**

```swift
import SwiftUI

struct PaymentsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var balance: Double = 0
    @State private var card: LinkedCard?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Payments", onBack: { dismiss() })

                    if isLoading {
                        VStack(spacing: 12) {
                            OxySkeletonCard(height: 92)
                            OxySkeletonCard(height: 92)
                        }
                        .padding(.horizontal, AppSpacing.margin)
                        .padding(.top, 16)
                    } else {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 28) {
                                if let errorMessage {
                                    ErrorBanner(message: errorMessage)
                                }
                                balanceSection
                                cardSection
                            }
                            .padding(.horizontal, AppSpacing.margin)
                            .padding(.vertical, 16)
                        }
                    }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .task { await loadPayments() }
            .refreshable { await loadPayments() }
        }
    }

    // MARK: - Sections

    private var balanceSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            AppSectionHeader(title: "Concierge balance").padding(.bottom, 12)
            Text(formattedBalance)
                .font(.rowTitle)
                .foregroundStyle(Color.appInk)
        }
    }

    private var cardSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            AppSectionHeader(title: "Linked card").padding(.bottom, 12)
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(cardTitle)
                        .font(.rowTitle)
                        .foregroundStyle(Color.appInk)
                    Text(cardSubtitle)
                        .font(.rowSecondary)
                        .foregroundStyle(Color.appMuted)
                }
                Spacer(minLength: 8)
            }
            .padding(.vertical, 14)
            .frame(minHeight: 44)
        }
    }

    private var formattedBalance: String {
        String(format: "%.2f", balance)
    }

    private var cardTitle: String {
        guard let card else { return "No card linked" }
        return "\(card.brand.capitalized) •••• \(card.last4)"
    }

    private var cardSubtitle: String {
        card == nil ? "Link a card so the agent can charge you directly" : "Linked"
    }

    // MARK: - Networking

    private func loadPayments() async {
        async let cardResult = fetchCard()
        async let balanceResult = fetchBalance()
        let (fetchedCard, fetchedBalance) = await (cardResult, balanceResult)
        await MainActor.run {
            card = fetchedCard
            balance = fetchedBalance ?? balance
            isLoading = false
        }
    }

    private func fetchCard() async -> LinkedCard? {
        do {
            let data = try await APIClient.shared.request(path: "/connectors/stripe/card")
            let response = try JSONDecoder().decode(CardResponse.self, from: data)
            await MainActor.run { errorMessage = nil }
            return response.card
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
            return nil
        }
    }

    private func fetchBalance() async -> Double? {
        do {
            let data = try await APIClient.shared.request(path: "/concierge/balance")
            let response = try JSONDecoder().decode(BalanceResponse.self, from: data)
            return response.balance
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
            return nil
        }
    }
}

// MARK: - Models

struct LinkedCard: Codable, Equatable {
    let customerId: String
    let paymentMethodId: String
    let brand: String
    let last4: String
}

private struct CardResponse: Codable {
    let card: LinkedCard?
}

private struct BalanceResponse: Codable {
    let balance: Double
}

#Preview {
    PaymentsView()
        .environment(AppState())
}
```

- [ ] **Step 2: Manually verify against the deployed backend**

In Xcode: run the app in the Simulator, signed in as a test account with no card linked yet. More tab → Payments.
Expected: skeleton loaders appear briefly, then "No card linked" / "Link a card so the agent can charge you directly" shows under Linked card, and the balance shows as a plain number (e.g. "0.00") under Concierge balance. Pull to refresh works without error.

- [ ] **Step 3: Commit**

```bash
git add OxyApp/OxyApp/Views/Payments/PaymentsView.swift
git commit -m "feat: show concierge balance and linked-card status on the Payments screen"
```

---

### Task 6: Link / replace card via Payment Sheet

**Files:**
- Modify: `OxyApp/OxyApp/Views/Payments/PaymentsView.swift` (extend the file from Task 5)

**Interfaces:**
- Consumes: `LinkedCard`, `isLoading`, `errorMessage`, `loadPayments()` (all from Task 5, same file). `PaymentSheet` and `PaymentSheetResult` from `StripePaymentSheet` (added in Task 4).
- Produces: a "Link a card" / "Replace card" button in `cardSection`. Task 7 (remove card) is added alongside this in the same section.

- [ ] **Step 1: Add the Payment Sheet state and trigger button**

In `PaymentsView.swift`, add `import StripePaymentSheet` at the top, add new `@State` properties, and update `cardSection`:

```swift
import SwiftUI
import StripePaymentSheet
```

Add alongside the existing `@State` properties in `PaymentsView`. Note `pendingSetupIntentSecret` is tracked as its own state rather than read back off `paymentSheet` — `PaymentSheet`'s public API doesn't expose the client secret it was constructed with, so the value that `confirmCardLink()` needs later has to be captured here, at the point it's still in scope:

```swift
    @State private var paymentSheet: PaymentSheet?
    @State private var pendingSetupIntentSecret: String?
    @State private var showingPaymentSheet = false
    @State private var isPreparingPaymentSheet = false
```

Replace `cardSection` with a version that adds the link/replace button:

```swift
    private var cardSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            AppSectionHeader(title: "Linked card").padding(.bottom, 12)
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(cardTitle)
                        .font(.rowTitle)
                        .foregroundStyle(Color.appInk)
                    Text(cardSubtitle)
                        .font(.rowSecondary)
                        .foregroundStyle(Color.appMuted)
                }
                Spacer(minLength: 8)
                linkButton
            }
            .padding(.vertical, 14)
            .frame(minHeight: 44)
        }
    }

    private var linkButton: some View {
        Button {
            Task { await startCardLink() }
        } label: {
            if isPreparingPaymentSheet {
                ProgressView().scaleEffect(0.65).tint(Color.appMuted)
            } else {
                Text(card == nil ? "Link" : "Replace")
                    .font(.appBody(14, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(Capsule().fill(Color.white.opacity(0.06)))
            }
        }
        .disabled(isPreparingPaymentSheet)
        .buttonStyle(.appScale(0.97))
    }
```

Add the `.paymentSheet` modifier and the networking/handling functions:

```swift
    private func startCardLink() async {
        await MainActor.run { isPreparingPaymentSheet = true }
        do {
            let data = try await APIClient.shared.request(path: "/connectors/stripe/setup-intent", method: "POST")
            let response = try JSONDecoder().decode(SetupIntentResponse.self, from: data)
            var configuration = PaymentSheet.Configuration()
            configuration.merchantDisplayName = "Oxy"
            let sheet = PaymentSheet(setupIntentClientSecret: response.clientSecret, configuration: configuration)
            await MainActor.run {
                paymentSheet = sheet
                pendingSetupIntentSecret = response.clientSecret
                isPreparingPaymentSheet = false
                showingPaymentSheet = true
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isPreparingPaymentSheet = false
            }
        }
    }

    private func handlePaymentSheetCompletion(_ result: PaymentSheetResult) {
        switch result {
        case .completed:
            Task { await confirmCardLink() }
        case .canceled:
            break
        case .failed(let error):
            errorMessage = error.localizedDescription
        }
    }

    private func confirmCardLink() async {
        // Stripe's server-side setupIntents.retrieve (called by /connectors/stripe/confirm)
        // accepts either the SetupIntent id or its client secret, so passing the client
        // secret through as setupIntentId needs no extra server-side lookup here.
        guard let setupIntentId = pendingSetupIntentSecret else { return }
        do {
            let data = try await APIClient.shared.request(
                path: "/connectors/stripe/confirm",
                method: "POST",
                body: ["setupIntentId": setupIntentId]
            )
            let response = try JSONDecoder().decode(ConfirmResponse.self, from: data)
            await MainActor.run {
                card = response.card
                errorMessage = nil
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }
```

Wire the `.paymentSheet` modifier onto the outer `ZStack` in `body` (add after the existing `.refreshable { await loadPayments() }` line):

```swift
            .task { await loadPayments() }
            .refreshable { await loadPayments() }
            .paymentSheet(isPresented: $showingPaymentSheet, paymentSheet: paymentSheet ?? PaymentSheet(setupIntentClientSecret: "", configuration: .init()), onCompletion: handlePaymentSheetCompletion)
```

Add the new response model next to the other private models near the bottom of the file:

```swift
private struct SetupIntentResponse: Codable {
    let clientSecret: String
    let customerId: String
    let publishableKey: String
}

private struct ConfirmResponse: Codable {
    let linked: Bool
    let card: LinkedCard?
}
```

- [ ] **Step 2: Build and manually verify**

In Xcode: Product → Build (⌘B).
Expected: builds with no errors.

Run in Simulator, go to Payments, tap "Link". Enter Stripe test card `4242 4242 4242 4242`, any future expiry, any 3-digit CVC, any ZIP. Complete the Payment Sheet.
Expected: sheet dismisses, "No card linked" changes to "Visa •••• 4242" / "Linked", and the button label changes from "Link" to "Replace".

- [ ] **Step 3: Commit**

```bash
git add OxyApp/OxyApp/Views/Payments/PaymentsView.swift
git commit -m "feat: link and replace a card via Stripe Payment Sheet"
```

---

### Task 7: Remove linked card

**Files:**
- Modify: `OxyApp/OxyApp/Views/Payments/PaymentsView.swift` (extend the file from Task 6)

**Interfaces:**
- Consumes: `card`, `errorMessage`, `LinkedCard` (Task 5/6, same file).
- Produces: a "Remove" action available whenever `card != nil`.

- [ ] **Step 1: Add the confirmation alert and remove button**

Add a new `@State` property alongside the others:

```swift
    @State private var showingRemoveConfirmation = false
```

Update `linkButton`'s enclosing `HStack` in `cardSection` to include a remove button when a card exists — replace the `Spacer(minLength: 8); linkButton` line with:

```swift
                Spacer(minLength: 8)
                if card != nil {
                    Button {
                        showingRemoveConfirmation = true
                    } label: {
                        Text("Remove")
                            .font(.appBody(14, weight: .semibold))
                            .foregroundStyle(Color.appMuted)
                    }
                    .buttonStyle(.appScale(0.97))
                    .padding(.trailing, 4)
                }
                linkButton
```

Add the alert modifier onto the outer `ZStack` in `body`, after the `.paymentSheet(...)` modifier:

```swift
            .alert("Remove linked card?", isPresented: $showingRemoveConfirmation) {
                Button("Remove", role: .destructive) { Task { await removeCard() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You'll need to link a new one before the agent can charge you directly.")
            }
```

Add the networking function:

```swift
    private func removeCard() async {
        do {
            _ = try await APIClient.shared.request(path: "/connectors/stripe/card", method: "DELETE")
            await MainActor.run {
                card = nil
                errorMessage = nil
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }
```

- [ ] **Step 2: Build and manually verify**

In Xcode: Product → Build (⌘B).
Expected: builds with no errors.

Run in Simulator with a card already linked (from Task 6). Payments screen → tap "Remove" → confirm in the alert.
Expected: row reverts to "No card linked" / "Link a card so the agent can charge you directly", button reverts to "Link".

- [ ] **Step 3: Commit**

```bash
git add OxyApp/OxyApp/Views/Payments/PaymentsView.swift
git commit -m "feat: let the user remove their linked card"
```

---

### Task 8: SCA re-auth banner on Today

**Files:**
- Create: `OxyApp/OxyApp/Views/Proactive/PaymentActionBanner.swift`
- Modify: `OxyApp/OxyApp/Views/Proactive/ProactiveView.swift:8-25` (new `@State`), `:52-56` (insert banner), `:109-117` (`.task`/`.onChange` fetch)

**Interfaces:**
- Consumes: `ErrorBanner`'s visual style as a reference (`OxyApp/OxyApp/Views/Components/ErrorBanner.swift`), `APIClient.shared.request` (`OxyApp/OxyApp/Services/APIClient.swift:49`), `STPPaymentHandler`/`STPAuthenticationContext` from `StripePayments` (transitively available via the `StripePaymentSheet` package added in Task 4).
- Produces: `PendingPaymentAction` model and `PaymentActionBanner` view, consumed only by `ProactiveView.swift` in this task.

- [ ] **Step 1: Create the banner view**

Create `OxyApp/OxyApp/Views/Proactive/PaymentActionBanner.swift`:

```swift
import SwiftUI
import UIKit
import StripePayments

struct PendingPaymentAction: Codable, Equatable {
    let paymentIntentId: String
    let clientSecret: String
    let amountCents: Int
    let description: String
    let currency: String?
}

struct PaymentActionBanner: View {
    let action: PendingPaymentAction
    let onHandled: () -> Void

    @State private var isConfirming = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "creditcard.trianglebadge.exclamationmark")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.appMuted)

            Text("Confirm your card for the \(formattedAmount) charge for \(action.description)")
                .font(.appBody(13))
                .foregroundStyle(Color.appMuted)
                .lineLimit(2)

            Spacer(minLength: 8)

            Button {
                confirm()
            } label: {
                if isConfirming {
                    ProgressView().scaleEffect(0.65).tint(Color.appAccent)
                } else {
                    Text("Confirm")
                        .font(.appBody(12, weight: .semibold))
                        .tracking(0.3)
                        .foregroundStyle(Color.appAccent)
                }
            }
            .disabled(isConfirming)
            .buttonStyle(.appScale)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.appSurface)
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous)
                .strokeBorder(Color.appHairline, lineWidth: 0.5)
        )
    }

    private var formattedAmount: String {
        let amount = Double(action.amountCents) / 100
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = (action.currency ?? "usd").uppercased()
        return formatter.string(from: NSNumber(value: amount)) ?? String(format: "%.2f", amount)
    }

    private func confirm() {
        isConfirming = true
        let authContext = KeyWindowAuthenticationContext()
        STPPaymentHandler.shared().handleNextAction(forPayment: action.clientSecret, with: authContext, returnURL: nil) { _, _, _ in
            isConfirming = false
            onHandled()
        }
    }
}

private final class KeyWindowAuthenticationContext: NSObject, STPAuthenticationContext {
    func authenticationPresentingViewController() -> UIViewController {
        let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene
        var top = windowScene?.windows.first { $0.isKeyWindow }?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top ?? UIViewController()
    }
}

#Preview {
    PaymentActionBanner(
        action: PendingPaymentAction(paymentIntentId: "pi_1", clientSecret: "secret", amountCents: 2500, description: "coffee", currency: "gbp"),
        onHandled: {}
    )
    .padding()
    .background(Color.appObsidian)
}
```

- [ ] **Step 2: Wire the banner into `ProactiveView`**

In `ProactiveView.swift`, add a new `@State` property alongside the existing ones (currently lines 8-25):

```swift
    @State private var pendingPaymentAction: PendingPaymentAction?
```

Insert the banner in `body`, right after the existing `errorMessage` banner (currently lines 52-56):

```swift
                        if let errorMessage {
                            ErrorBanner(message: errorMessage).padding(.bottom, 16)
                        }

                        if let pendingPaymentAction {
                            PaymentActionBanner(action: pendingPaymentAction, onHandled: {
                                Task {
                                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                                    await loadPendingPaymentAction()
                                }
                            })
                            .padding(.bottom, 16)
                        }
```

Add the fetch function near `loadDashboard` (wherever that function is defined in this file):

```swift
    private func loadPendingPaymentAction() async {
        do {
            let data = try await APIClient.shared.request(path: "/connectors/stripe/payment-action")
            let response = try JSONDecoder().decode(PaymentActionResponse.self, from: data)
            await MainActor.run { pendingPaymentAction = response.action }
        } catch {
            // Silent — this is a secondary signal, not the primary dashboard load;
            // errorMessage stays reserved for loadDashboard's own failures.
        }
    }

    private struct PaymentActionResponse: Codable {
        let action: PendingPaymentAction?
    }
```

Update the `.task` and `.onChange(of: scenePhase)` blocks (currently lines 109-117) to also fetch it:

```swift
        .task {
            guard !appState.isDemoSession else { return }
            await native.prepareTodayAccess()
            await loadDashboard()
            await loadPendingPaymentAction()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, !appState.isDemoSession else { return }
            Task {
                await loadDashboard()
                await loadPendingPaymentAction()
            }
        }
```

- [ ] **Step 3: Build and manually verify the full 3DS path**

In Xcode: Product → Build (⌘B).
Expected: builds with no errors.

Run in Simulator. Link a card using Stripe's 3DS test card `4000 0025 0000 3155` via the Payments screen (Task 6's flow). Trigger a charge that goes through `spend_from_concierge_account`, `stripe_charge`, or `spend_from_concierge_via_stripe` for this user (e.g. via a chat message asking the agent to spend from the concierge account) — this card forces `requires_action`.
Expected: on next Today load (or app foreground), the banner appears with the correct currency-formatted amount and description. Tapping "Confirm" presents Stripe's native 3DS challenge sheet; completing it (test cards auto-approve the challenge in test mode) dismisses the sheet, and the banner disappears within a few seconds once the webhook clears the pending record.

- [ ] **Step 4: Commit**

```bash
git add OxyApp/OxyApp/Views/Proactive/PaymentActionBanner.swift OxyApp/OxyApp/Views/Proactive/ProactiveView.swift
git commit -m "feat: add Today banner for SCA re-authentication on parked Stripe charges"
```

---

## Post-plan note

Nothing in this plan pushes the iOS commits anywhere (there's no CI/App Store pipeline wired up yet per existing memory — Apple Developer Program is still a blocker for TestFlight/App Store distribution). Only Task 3's backend commit needs a push to `origin/main` to reach the deployed Cloud Run backend; the iOS commits (Tasks 4-8) stay local until you're ready to build/test on a device or in the Simulator, which doesn't require pushing.
