# Stripe webhook events HoundStack requires

Stripe sends **only the events you select**. An event that is handled in code
but not selected in the dashboard never arrives, and nothing anywhere reports
that it did not — no error, no gap in a log, nothing. That failure mode has
already cost us twice (BUG-34, BUG-35), so this file exists to be checked
against the dashboard rather than remembered.

Generated from the handlers, not from memory. If you change which events a
handler processes, change this list in the same commit.

> This claim was false once already. On 2026-08-04 the file listed 8 Connect
> events while the handlers processed 14 — the six missing ones being exactly
> those that move or protect money (`charge.refund.updated`, `payout.*`,
> `radar.*`, `setup_intent.succeeded`, `account.application.deauthorized`).
> The coverage test guards subscribed→handler; it does not guard
> handler→documented, so this direction is checked by reading.

There are **two separate endpoints** and they are not interchangeable.

---

## 1. Connect endpoint — tenant money

`POST /api/public/hooks/stripe` · handler `src/routes/api/public/hooks/stripe.ts`

These fire on **connected accounts**, so in the Stripe dashboard they must be
enabled on a **Connect** endpoint ("Listen to events on Connected accounts").
A normal account endpoint with the same events selected will not deliver them,
and the symptom is silence.

| Event | What breaks without it |
|---|---|
| `payment_intent.succeeded` | Payments are never recorded. Revenue, invoices and settlements all read zero. |
| `payment_intent.payment_failed` | A failed card looks like it never happened; dunning never starts. |
| `checkout.session.completed` | Handled, but **not load-bearing today**: nothing in `src/` calls `checkout.sessions.create` (only `.retrieve`), and signup prepay is a PaymentIntent. Kept subscribed because the handler exists and a hosted-checkout path would depend on it. The previous entry here claimed top-ups and signup payments never complete without it, which was not true, and OPS_RUNBOOK said the opposite — two documents disagreeing about the same event. |
| `charge.refunded` | Refunds are invisible. Revenue counts money that went back to the customer, and the franchise settlement bills a location for it. |
| `charge.dispute.created` | Chargebacks and inquiries are invisible. Same consequence as a missing refund, plus nobody learns a dispute has a deadline until it has passed. |
| `charge.dispute.updated` | **Easy to skip — it sounds like a notification and is not.** Stripe promotes an inquiry to a real chargeback by changing `status` on the *existing* dispute, and arbitration flips a won dispute to lost the same way. Money moves on both, and **neither raises `created` or `closed`**. Without this event the two cases where funds leave without a new dispute object are exactly the two the system cannot see. |
| `charge.dispute.closed` | A dispute never resolves. A won dispute never repays the location; the queue shows an open dispute for ever. |
| `account.updated` | Onboarding never completes — a tenant who has finished verification still reads as pending, and payouts stay disabled in our UI. |
| `account.application.deauthorized` | A tenant disconnects HoundStack from *their own* Stripe dashboard and we never learn. `stripe_connect_charges_enabled` stays true for ever, every later charge fails at the Stripe API, and neither side gets a signal explaining why. |
| `setup_intent.succeeded` | A card saved through either inline flow exists at Stripe and not here if the browser closes between confirm and record — so autopay silently never runs for that client. |
| `charge.refund.updated` | **A refund is not final when it is created.** It can fail afterwards — closed card, rejected ACH return — and Stripe reports it here, decrementing `amount_refunded`. Without it the ledger keeps a refund deducted that never actually happened, and the payment stays marked refunded. |
| `payout.paid` | "When does my money arrive" is the tenant's first question. The embedded balances component shows it live, but nothing on our side knows, so nothing can notify or report. |
| `payout.failed` | A stale bank account halts **every** payout, not just one, and the only place that was visible is Stripe. |
| `radar.early_fraud_warning.created` | The network naming a charge as probably fraudulent before the customer disputes it. Refunding on an EFW usually avoids the chargeback and its fee — but only if the tenant hears in time. |

**Do not add `charge.dispute.funds_withdrawn` or
`charge.dispute.funds_reinstated`.** They describe the same money as
`created` / `closed` / `updated`, which is what the ledger keys on. Subscribing
to them would file a second set of rows for one dispute.

## 2. Platform endpoint — HoundStack's own SaaS billing

`POST /api/public/hooks/platform-stripe` · handler
`src/routes/api/public/hooks/platform-stripe.ts`

These fire on **our own account** — a normal (non-Connect) endpoint.

| Event | What breaks without it |
|---|---|
| `customer.created`, `customer.updated` | The tenant↔Stripe customer link goes stale. |
| `customer.subscription.created` | A tenant pays and the app never learns they are on a plan. |
| `customer.subscription.updated` | Plan changes, seat quantity and renewal dates stop tracking. |
| `customer.subscription.deleted` | A cancelled tenant keeps their plan for ever. See BUG-29 — this one also decides whether AI keeps running on our keys. |
| `customer.subscription.trial_will_end` | Fires three days out. Its absence is worse than neutral: a charge nobody expected produces a dispute rather than a cancellation. |
| `invoice.created`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible` | The platform invoice list is incomplete, and `plan_status` stops following what was actually paid. |

---

## Checking it

Compare this table against the endpoint's selected events in the dashboard.
The code's own list can be regenerated at any time:

```sh
grep -oh 'event\.type === "[a-z_.]*"' src/routes/api/public/hooks/stripe.ts \
  | sed 's/.*"\(.*\)"/\1/' | sort -u
grep -n '^\s*case "' src/routes/api/public/hooks/platform-stripe.ts \
  | sed 's/.*case "\(.*\)".*/\1/' | sort -u
```

Nothing automated verifies the dashboard matches this file — that would need
Stripe credentials CI does not have, and a check that only runs when
credentials happen to be present passes silently in exactly the environment
everyone trusts. So it is a manual step at setup, which is why the consequence
column exists: it is meant to be read while clicking the boxes.
