# Tap to Pay on the phone (#579)

The phone is the card reader. An owner or office manager opens an open
invoice in the **native app**, presses **Tap to Pay on iPhone** (on Android,
**Tap to Pay**), and the customer taps a card or phone on it. Stripe Terminal, Tap to Pay on iPhone
and on Android, through `@capacitor-community/stripe-terminal` (pinned at
8.3.0).

## Where the money goes

Exactly where Take payment sends it: a **direct charge on the business's
connected account**. Every Stripe call carries `{ stripeAccount }`:

| Step | Server function | Stripe call (on the connected account) |
| --- | --- | --- |
| Before discovery | `prepareTapToPay` | `terminal.locations.list`, then `create` once per business (idempotency key `tap-to-pay-location:<org id>`) |
| Whenever the SDK asks | `createTapToPayConnectionToken` | `terminal.connectionTokens.create({ location })` |
| Before the tap | `createTapToPayPaymentIntent` | `paymentIntents.create({ amount: dueCents, application_fee_amount: platformFeeCents(dueCents, invoice), payment_method_types: ["card_present"], capture_method: "automatic" })` |

All three require `manage_client_billing`, the permission
`createInvoicePaymentIntent` requires, so a role that cannot Take payment
cannot tap either. The location is found again by its metadata
(`houndstack_tap_to_pay=1`, `organization_id`), so no database column or
migration was added. It needs the business address (Settings, Client portal)
written as `street, city, ST ZIP`; without it the app says so.

The intent's metadata is `source: "staff_inline"`, `channel: "tap_to_pay"`,
`invoice_id`, `organization_id`, `tip_cents: "0"`. The existing
`payment_intent.succeeded` branch of `src/routes/api/public/hooks/stripe.ts`
already marks the invoice paid and writes the `payments` row through
`markInvoicePaidFromStripe` for `staff_inline`, and filters on `source`, never
on the payment method type, so **the webhook needed no change**. After the SDK
confirms, the app also calls `reconcileInvoiceNow`, as the card form does, so
the screen flips to paid without waiting for the webhook.

## Who pays Stripe's $0.10 per tap

Owner decision (2026-11-10): the business that takes the tap bears Stripe's
per-tap fee, and the platform is never billed net for a tenant's taps.

**Which fee payer HoundStack's connected accounts have.** They are created in
`ensureExpressAccount` (`src/lib/stripe-connect.server.ts:159-169`) with the
legacy `type: "express"` and no `controller`. Stripe records that as
`controller.fees.payer: "application_express"`
([migrate-to-controller-properties](https://docs.stripe.com/connect/migrate-to-controller-properties)).
For **direct** charges, Stripe's fee table puts payment processing fees on the
**connected account** under `application_express`
([direct-charges-fee-payer-behavior](https://docs.stripe.com/connect/direct-charges-fee-payer-behavior)),
and its Terminal-on-Connect page says that with direct charges "the connected
account is responsible for the cost of Stripe fees"
([terminal/features/connect](https://docs.stripe.com/terminal/features/connect?connect-charge-type=direct)).
So for every account HoundStack creates today, the per-tap fee lands on the
business, and nothing is added for taps.

**The code does not assume that.** On every tap, `createCardPresentIntent`
(`src/lib/tap-to-pay.server.ts`) reads `controller.fees.payer` from the
account:

| `fees.payer` | Who Stripe bills for a direct charge | Application fee on the tap |
| --- | --- | --- |
| `account`, `application_express`, `application_custom` | the business | `platformFeeCents(dueCents, invoice)` (Take payment's) |
| `application`, or unreadable | the platform | `platformFeeCents(...) + TAP_TO_PAY_FEE_CENTS` (10) |

The client is always charged the amount due and nothing more. The application
fee comes out of what the business is paid, and the invoice is credited the
full charge, as before. The intent's metadata records `tap_to_pay_fee_cents`
and `connect_fee_payer`, so a payout can be traced back. Take payment is
unchanged.

**Refunds and disputes.** Stripe does not return the fee it billed for a
refunded or disputed tap, so the per-tap part of the application fee is never
handed back: the `charge.refunded` and dispute branches of
`src/routes/api/public/hooks/stripe.ts` reverse
`reversibleApplicationFeeCents(fee, metadata)` (the fee minus the intent's
`tap_to_pay_fee_cents`) proportionally, as they always have for the platform
fee. Under `application_express` that part is zero, so nothing changes there.

**What the business sees.** The Tap to Pay card says, before the first tap,
"Each tap costs your business $0.10 on top of the card rate, taken out of the
payout and shown in Stripe." In the business's Stripe payments view, the tap fee appears
either as a Stripe fee (`application_express`) or as an application fee
(`application`).

**Live pricing check (read-only, done 2026-11-10).** The live Connect platform
`acct_1U0CVSQUHYdejlaV` is on standard blended pricing, not IC+. Evidence,
from the connected accounts' own balance transactions:

- `ch_3UXBtRH7o0ny3UiP0CxQsNBp` on `acct_1U0oZzH7o0ny3UiP`:
  `txn_3UXBtRH7o0ny3UiP02bEe6Qx`, amount 6000, fee 204, net 5796.
  `fee_details` is one line: `{ type: stripe_fee, amount: 204, description:
  "Stripe processing fees", application: null }` (2.9% + 30c).
- `ch_3UXQlPQg89H4tWg50gmDreSN` on `acct_1UUvxbQg89H4tWg5`:
  `txn_3UXQlPQg89H4tWg50Xv69PHh`, amount 2000, fee 88, net 1912.
  `fee_details` is one line: `{ type: stripe_fee, amount: 88, description:
  "Stripe processing fees", application: null }` (2.9% + 30c).

Neither has an interchange-plus or network-cost line, and the fee sits on the
connected account. Under `application_express` that means the "nothing added"
branch does not leak.

**Test-mode tap proof: skipped by Brendan's decision, Nov 10 12:52 AM ET.**
Cleared on live blended-fee evidence `txn_3UXBtRH7o0ny3UiP02bEe6Qx` and
`txn_3UXQlPQg89H4tWg50Xv69PHh` plus the fee tests. Check the first real
tap's `fee_details` on the connected account once Tap to Pay is live.

## Who sees what

`tapToPayGate` in `src/lib/tap-to-pay.ts` decides whether Tap to Pay appears
on an invoice at all, and in which form:

- never on the web or the PWA (`IS_NATIVE_BUNDLE`), never on an iPad, never on
  Android below 13;
- never before card payments are ready, or on an invoice with nothing due;
- `ready`: the button, for a role with `manage_client_billing` (owner,
  office manager);
- `ask_admin`: any other role sees "Taking payments by tap is for the account
  owner and office managers. Ask your account owner if you need it." instead
  of nothing (Apple 3.8.1). The server refuses them anyway;
- `update_ios`: an iPhone below iOS 16.4 (Stripe's floor) sees "Update this
  iPhone to the latest version of iOS..." instead of nothing (Apple 1.4). An
  iPhone on 16.4 to 17.5 can tap, with a note recommending the update.

Only the **owner** (`manage_org_billing`) may accept Apple's terms (Apple 3.8).
An office manager can tap once they are accepted; if they are not, the tap
stops before Apple's sheet would appear and says "Ask your account owner to
turn on Tap to Pay on iPhone..." (3.8.1).

Whether this exact phone passes Stripe's checks (iPhone XS or later; NFC on,
not rooted, Developer options off on Android) is only known when the SDK looks
for its reader; `describeTapToPayError` turns the answer into a sentence.

## Apple's review guide (v1.8): what each screen does

| Requirement | Where |
| --- | --- |
| 1.4 update to the latest iOS before 17.6 | `iosUpdateAdvice`; the pay card, the Settings card |
| 1.5, 5.6 warm-up at launch and on foreground | `startTapToPayOnLaunch` in `src/lib/tap-to-pay-terminal.ts`, started by the `_authenticated` layout (`tap_to_pay_warm_up` step). Connects the reader only where Apple's terms are already accepted, so it never raises Apple's sheet |
| 1.6 terms status from Apple each time | `isTapToPayAccountLinked` on every tap and every Settings visit, never cached |
| 3.1, 3.3, 6.2 awareness | `TapToPayAnnouncement`: full screen, once per phone, for an iPhone merchant whose business has Tap to Pay available |
| 3.5, 3.6 enable outside checkout | "Enable Tap to Pay on iPhone" on the announcement and on Payments, Settings (`TapToPaySettingsCard`). This is where the owner accepts Apple's terms |
| 3.8, 3.8.1 admin only, ask your admin | `canAcceptTapToPayTerms`, `TapToPayNeedsAdminError`, `TAP_TO_PAY_MESSAGES.askAdmin` |
| 3.9.1, 5.7 setup progress | `TapToPayProgress`, fed by the plugin's `StartInstallingUpdate`, `ReaderSoftwareUpdateProgress` and `FinishInstallingUpdate` events |
| 4.1, 4.2, 4.5, 4.6, 4.7 education, PIN entry | `TapToPayEducation`: how to tap, cards and wallets, PIN entry, if a tap does not work. On iOS 18+ it first offers Apple's own guide through `ProximityReaderDiscovery` (`ios/App/App/TapToPay/TapToPayEducationPlugin.swift`) |
| 4.3 education in Settings | "How it works" on the Settings card and on the pay card |
| 5.2 first, no scrolling | `StaffInvoicePayForm` draws Tap to Pay directly under Amount due, above Saved card and Account credit |
| 5.4, 5.5 label and icon | "Tap to Pay on iPhone", no amount, `TapToPayMark` (SF Symbol `wave.3.right.circle` drawn as SVG). Never the Apple logo |
| 5.8 processing | its own "Processing payment" state while the card is approved |
| 5.10 receipt | after an approval and after a decline, "Send receipt" opens the share sheet with a receipt the customer can get by text, email or AirDrop. An approval also sends the usual payment-received email where the business has it on |
| 5.12 not approved after the app closed | a tap waiting for a card or approval is recorded; leaving the app calls `reportTapToPayInterrupted`, which pushes the person who started it if the intent did not succeed. The next launch says so in the app too |

Not in this change: 3.4 (offer Tap to Pay at the end of new-merchant
onboarding) waits for a free slot on `setup.tsx`; 3.9 "Try it out", 6.1 and
6.3 launch marketing, and 1.7 Face ID sign-in are out of scope.

**Hero image (Marketing Toolkit).** The announcement loads
`public/tap-to-pay/hero-in-app-banner.png`, Apple's Hero in-app banner from the
Tap to Pay on iPhone Marketing Toolkit. The file is not in the repo yet; until
it is dropped in, the drawn symbol shows in its place.

## Which reader: simulated, the real phone, or none

The plugin's `initialize({ isTest })` also makes discovery simulated, so a
simulated reader never shows Apple's screens. `tapToPayReaderMode` in
`src/lib/tap-to-pay.server.ts`:

| Keys | Business | Reader |
| --- | --- | --- |
| test (`sk_test_`, `rk_test_`) | any | Stripe's simulated reader (unchanged) |
| live | on `TAP_TO_PAY_LIVE_ORG_IDS` | the **real phone reader**, live mode |
| live | anyone else | none: "Tap to Pay isn't turned on for this business yet." |

`TAP_TO_PAY_LIVE_ORG_IDS` is a server environment variable, comma-separated
organization ids. **Unset, no business gets it**, so no production customer
is enabled by default. Detroit Doo Disposal is refused by name even if its id
is added by mistake. Prepare, the connection token and the payment intent all
check it. There is deliberately no "test keys plus a physical test card"
path.

## Runbook: the $1 recording charge for Apple (case 23404969)

Brendan's decision (2026-11-10, 1:53 AM ET): "Run one real $1 charge and
refund it."

1. **Who records:** Brendan, on a development-signed iPhone build (provisioning
   profile with the Tap to Pay on iPhone capability), iPhone XS or newer, on
   the latest iOS.
2. **Which business:** the designated demo business only. Put its
   organization id, and only its id, in `TAP_TO_PAY_LIVE_ORG_IDS` on the
   server the build talks to. Never Detroit Doo Disposal, never a customer.
   The demo business needs a charge-ready live connected account and a
   business address (Settings, Client portal).
3. **What to record:** the announcement, Enable Tap to Pay on iPhone from
   Payments (Apple's terms sheet, then the setup meter), How it works, then a
   $1.00 invoice: Tap to Pay on iPhone first in the list, Apple's tap screen,
   Processing payment, Payment approved, Send receipt.
4. **The charge:** live mode. Brendan taps **his own real card** for $1.00.
5. **The refund:** SIC refunds the $1.00 in Stripe after the recording.
   Nobody else charges or refunds it.
6. **After:** remove the id from `TAP_TO_PAY_LIVE_ORG_IDS` (or leave only the
   demo business) until Tap to Pay is approved and launched.

## Test-mode path: a $1.00 invoice to paid on a Connect demo org

Uses Stripe **test** keys only, and so Stripe's **simulated** reader: it
proves the money path, not Apple's screens. The recording for Apple uses the
live runbook above instead.

1. Run the native app against staging/test keys (`STRIPE_CONNECT_SECRET_KEY`
   starting `sk_test_`). `prepareTapToPay` reports `isTest: true`, and the app
   initialises the Terminal SDK in test mode, which gives a **simulated Tap to
   Pay reader**. A simulator or a physical device both work in test mode.
2. Use a demo org whose test-mode connected account is charge-ready (Payments
   page) and whose business address is set (Settings, Client portal).
3. Create a manual invoice for **$1.00**, send it so it is open, open it, and
   press **Take payment**, then **Tap to Pay on iPhone**.
4. The simulated reader "taps" a test card. Expect: the toast
   "Payment received: $1.00 by tap.", the invoice shows **Paid**.
5. Check, in the Stripe dashboard for the **connected account** (not the
   platform): a PaymentIntent for 100 cents, `payment_method_types:
   ["card_present"]`, metadata `channel=tap_to_pay`, and an application fee
   equal to what Take payment charges for $1.00 (today: none, because
   `platformFeeCents` is zero and $1.00 is under the $10 floor anyway).
6. Check, in the database: one `payments` row for the invoice, 100 cents,
   `stripe_payment_intent_id` = that intent, status `succeeded`; the invoice
   `status = 'paid'`. Same shape as a Take payment row.
7. A Terminal Location named after the business exists on the connected
   account. Run it again: no second location is created.

## Native setup that ships with this change

- **iOS**: `com.apple.developer.proximity-reader.payment.acceptance` in
  `App.entitlements`; `NSBluetoothAlwaysUsageDescription` (the Stripe SDK links
  CoreBluetooth for hardware readers); the location purpose string says Stripe
  checks location on a tap; `TapToPayEducationPlugin.swift`, a local plugin
  registered in `HSBridgeViewController`, for Apple's ProximityReaderDiscovery
  (iOS 18+). Apple granted the Tap to Pay on iPhone
  entitlement to the HoundStack developer account on 2026-11-09. A signed
  build needs a provisioning profile that includes the Tap to Pay on iPhone
  capability (regenerate the profile after enabling it on the app ID); a
  profile without it fails to sign. The simulator launch in CI builds
  unsigned and is unaffected.
- **Android**: `NFC` permission and `android.hardware.nfc` as
  `required="false"`; `minSdkVersion` 24 to 26, the Stripe Terminal SDK's
  floor. The plugin's manifest merges `BLUETOOTH_CONNECT`.

## Still needs a person

- A physical iPhone build signed with a provisioning profile that includes
  the Tap to Pay on iPhone capability; a physical Android 13+ phone with
  Developer options **off** (Stripe refuses a phone with them on).
- The live $1 recording charge and its refund (runbook above): Brendan
  records, SIC refunds.
- Confirmation that Terminal is enabled for Connect direct charges on the live
  platform, and that the live platform is on standard blended pricing, not
  IC+ (Stripe bills "Interchange Plus Payment Fees" to the platform under
  `application_express`, which reading `fees.payer` cannot detect).
  (Done: Apple entitlement granted 2026-11-09; the business bears the per-tap
  fee, decided 2026-11-10.)
