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
  checks location on a tap. **A signed build fails until Apple grants the
  development (then distribution) entitlement to the app ID.** The simulator
  launch in CI builds unsigned and is unaffected.
- **Android**: `NFC` permission and `android.hardware.nfc` as
  `required="false"`; `minSdkVersion` 24 to 26, the Stripe Terminal SDK's
  floor. The plugin's manifest merges `BLUETOOTH_CONNECT`.

## Still needs a person

- A physical iPhone with the development entitlement, a physical Android 13+
  phone with Developer options **off** (Stripe refuses a phone with them on).
- One live $1 charge, refunded, after Brendan approves.
- Apple entitlement request; confirmation that Terminal is enabled for Connect
  direct charges on the live platform; a decision on who absorbs Stripe's
  per-tap Terminal fee.
