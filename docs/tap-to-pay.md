# Tap to Pay on the phone (#579)

The phone is the card reader. An owner or office manager opens an open
invoice in the **native app**, presses **Tap to pay $X.XX**, and the customer
taps a card or phone on the back of it. Stripe Terminal, Tap to Pay on iPhone
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

**Radar (#825).** Radar does not screen an in-person tap, so a tap carries no
Radar fee; the tap intent still records `radar_fee_cents: "0"`. Every online
card charge does pass Radar through, and under `application_express` too,
because that is where Stripe billed Radar to the platform. See
`docs/stripe-connect-fees.md`.

**What the business sees.** The Tap to pay card says, before the first tap,
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

## Who sees the button

`tapToPayGate` in `src/lib/tap-to-pay.ts`, all of:

- the app binary (`IS_NATIVE_BUNDLE`), never the web or the PWA;
- an iPhone on iOS 16.4+ (not iPad), or Android 13+;
- a role with `manage_client_billing` (owner, office manager; not tech or
  dispatcher);
- card payments ready (a charge-ready connected account);
- an open invoice with money due.

Whether this exact phone passes Stripe's checks (iPhone XS or later; NFC on,
not rooted, Developer options off on Android) is only known when the SDK looks
for its reader; `describeTapToPayError` turns the answer into a sentence.

## Test-mode path: a $1.00 invoice to paid on a Connect demo org

Uses Stripe **test** keys only. No live charge.

1. Run the native app against staging/test keys (`STRIPE_CONNECT_SECRET_KEY`
   starting `sk_test_`). `prepareTapToPay` reports `isTest: true`, and the app
   initialises the Terminal SDK in test mode, which gives a **simulated Tap to
   Pay reader**. A simulator or a physical device both work in test mode.
2. Use a demo org whose test-mode connected account is charge-ready (Payments
   page) and whose business address is set (Settings, Client portal).
3. Create a manual invoice for **$1.00**, send it so it is open, open it, and
   press **Take payment**, then **Tap to pay $1.00**.
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
  checks location on a tap. Apple granted the Tap to Pay on iPhone
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
- One live $1 charge, refunded, after Brendan approves.
- Confirmation that Terminal is enabled for Connect direct charges on the live
  platform, and that the live platform is on standard blended pricing, not
  IC+ (Stripe bills "Interchange Plus Payment Fees" to the platform under
  `application_express`, which reading `fees.payer` cannot detect).
  (Done: Apple entitlement granted 2026-11-09; the business bears the per-tap
  fee, decided 2026-11-10.)
