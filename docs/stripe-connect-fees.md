# Who pays Stripe's per-charge costs on Connect (#757, #825)

Owner rule (Brendan, Nov 10 2026): "I don't get charged for other users."
Each business bears its own payment costs. Two of Stripe's costs need code
to make that true, because on HoundStack's accounts Stripe can bill them to
the platform: the Tap to Pay fee (#757, see `docs/tap-to-pay.md`) and the
Radar screening fee (#825, this page).

Brendan's decision for Radar (Nov 10 2026, 1:45 AM ET), word for word:
"Pass Radar fees to each business, like the tap fee".

## Why Radar landed on the platform

Every tenant charge is a direct charge on the business's connected account,
and every account is created with the legacy `type: "express"`
(`src/lib/stripe-connect.server.ts:159-169`), which Stripe records as
`controller.fees.payer: "application_express"`.

Stripe's fee-payer table for direct charges
([direct-charges-fee-payer-behavior](https://docs.stripe.com/connect/direct-charges-fee-payer-behavior))
has a Radar row:

| `fees.payer` | `account` | `application` | `application_custom` | `application_express` |
| --- | --- | --- | --- | --- |
| Radar | Connected account | Platform | Varies | Varies |

The live, read-only check on #825 settled "Varies" for these accounts: Radar
debits of -$0.30 (Nov 2), -$0.15 (Nov 3) and -$0.10 (Nov 6) on the platform
balance. Until #825, `platformFeeCents()` returned undefined for every charge
(the platform fee is zero), so `application_fee_amount` was omitted and
nothing came back to the platform to cover them.

The card processing fee itself is not part of this: the live balance
transactions show it on the connected account (`fee_details` is one
`stripe_fee` line). The -$2.04 platform debit on Nov 8 was a
`reserve_transaction` for a negative balance after a refund, which is loss
liability (`controller.losses.payments: application`), not a fee. Brendan
decided that separately (Nov 10 2026, 6:36 AM ET): "Keep Express; HoundStack
stays liable". See "Loss liability" below.

## How it is passed through

`src/lib/radar-fee.ts` and `src/lib/connect-fee-payer.server.ts`.

- **The amount** is `RADAR_SCREENING_FEE_CENTS = 5`, Stripe's published
  per-screening price for Radar outside standard blended pricing. Every live
  Radar debit on #825 is a whole multiple of it. It is a constant, so tests
  are deterministic; it is not read from Stripe, because Radar is not a line
  in the connected account's `fee_details` (the live rows have only
  `stripe_fee`) and the platform-side debit is not tied to a charge we can
  read at charge time.
- **Who is billed** is read from the account on each charge
  (`connectedAccountFeePayer`, two attempts):

  | `fees.payer` | Radar billed to | Added to the application fee |
  | --- | --- | --- |
  | `account` | the business | nothing |
  | `application`, `application_express`, `application_custom` | the platform | 5 cents |
  | unreadable, or missing | assumed platform | 5 cents |

  This is not the tap fee's table: the tap fee is added only for
  `application` or unreadable, because Stripe bills processing fees on a
  direct charge to the business under `application_express`. Radar is the
  case where `application_express` bills the platform.
- **What is screened:** online card payments (`card`, `link`, or unpinned
  automatic methods). A bank debit (`us_bank_account`) and an in-person tap
  (`card_present`) are not screened, so they carry nothing. The saved-method
  paths know the method's rail and judge by it.
- **How:** `withPassThroughFees(platformFeeCents(...), radar.cents)` at every
  connected-account charge. With the platform fee at zero that sets
  `application_fee_amount` to 5, which moves five cents of the charge from
  the business's settlement to the platform. The client is charged the amount
  due and nothing more.
- **Recorded:** every intent's metadata carries `radar_fee_cents` ("0"
  included) and `connect_fee_payer`.

Charge sites (all wrap the fee in `withPassThroughFees`):

| Path | File |
| --- | --- |
| Take payment (card or bank) | `src/lib/invoices.functions.ts`, `createInvoicePaymentIntent` |
| Staff saved-card charge | `src/lib/invoices.functions.ts`, `chargeSavedCardCore` |
| Public pay link | `src/lib/invoices.functions.ts` |
| Client portal pay page | `src/lib/portal.functions.ts` |
| Client portal saved card | `src/lib/portal.functions.ts` |
| Nightly autopay | `src/routes/api/public/hooks/nightly.ts` |
| Online signup prepay | `src/lib/signup.functions.ts` |
| Tap to Pay | `src/lib/tap-to-pay.server.ts` (computed; zero for `card_present`) |
| Reconcile shrinking a stale intent | `src/lib/invoice-reconcile.server.ts` (keeps what create set) |

`tests/the-platform-fee-has-one-definition.test.ts` refuses a charge site
whose fee is not wrapped, and `tests/radar-fees-are-the-business-s.test.ts`
pins the math, every fee payer, an unreadable account, refunds, disputes, and
that each path reads the account and writes the metadata.

## Refunds and disputes

Stripe keeps its Radar fee when a charge is refunded or disputed, so the
Radar part of the application fee is never handed back.
`reversibleApplicationFeeCents` subtracts `radar_fee_cents` and
`tap_to_pay_fee_cents` from the fee before the `charge.refunded` and dispute
branches of `src/routes/api/public/hooks/stripe.ts` reverse the rest pro rata.
At today's zero platform fee that rest is zero. When the intent's metadata
cannot be read, nothing is reversed and the charge is logged.

The one exception is the refund the app issues itself: `provisionSignup`
unwinding a signup that HoundStack failed to provision. It still sends
`refund_application_fee: true`, so the business gets the whole fee back,
Radar part included. The failure was HoundStack's, so the platform absorbs
that five cents rather than charging the business for its own defect.

## What the business is told

The Payments page says, before connecting and beside the processing-fee
setting: "Each online payment a client can make by card also costs your
business $0.05 for Stripe's fraud check (Radar), even when the client ends up
paying by bank. It is taken out of the payout and shown in Stripe as an
application fee." It names the bank case because of the first known gap
below: the fee is set before the client picks how to pay.

## Known gaps

- **Intents that offer card and bank.** Take payment, the portal pay page and
  the public link offer both, and the application fee is set before the payer
  chooses. A payment made by bank on such an intent carries five cents Stripe
  did not bill. That errs toward the business paying its own costs, as the tap
  fee does for an unreadable account.
- **Declined and blocked attempts.** If Stripe bills Radar for a screening
  that ends in a decline, there is no charge and no application fee to
  recover it from. Covering that needs a reconciliation against the
  platform's Radar debits, not a charge-time fee.
- **The exact live rate.** That the platform is billed five cents per
  screening, and that the pass-through lands on the connected account, is
  still to be shown in Stripe test mode. That proof is outstanding and needs
  a separate, approved check.
- **Loss liability stays with HoundStack.** Brendan's decision (Nov 10 2026,
  6:36 AM ET), word for word: "Keep Express; HoundStack stays liable". It
  replaces his earlier "Make new businesses liable, if Stripe allows". Every
  connected account, existing and new, is still created as legacy
  `type: "express"` (`losses.payments: application`, `fees.payer:
  application_express`, the Express Dashboard), so HoundStack covers
  refunds, disputes and negative balances (reserves like the Nov 8 one) on
  all of them. The Radar pass-through above is what keeps the business
  paying its own Radar fee under that setup.
