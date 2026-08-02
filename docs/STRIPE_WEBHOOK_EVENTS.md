# Stripe webhook events HoundStack requires

Stripe sends **only the events you select**. An event that is handled in code
but not selected in the dashboard never arrives, and nothing anywhere reports
that it did not — no error, no gap in a log, nothing. That failure mode has
already cost us twice (BUG-34, BUG-35), so this file exists to be checked
against the dashboard rather than remembered.

Generated from the handlers, not from memory. If you change which events a
handler processes, change this list in the same commit.

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
| `checkout.session.completed` | Prepaid top-ups and signup payments never complete. |
| `charge.refunded` | Refunds are invisible. Revenue counts money that went back to the customer, and the franchise settlement bills a location for it. |
| `charge.dispute.created` | Chargebacks and inquiries are invisible. Same consequence as a missing refund, plus nobody learns a dispute has a deadline until it has passed. |
| `charge.dispute.updated` | **Easy to skip — it sounds like a notification and is not.** Stripe promotes an inquiry to a real chargeback by changing `status` on the *existing* dispute, and arbitration flips a won dispute to lost the same way. Money moves on both, and **neither raises `created` or `closed`**. Without this event the two cases where funds leave without a new dispute object are exactly the two the system cannot see. |
| `charge.dispute.closed` | A dispute never resolves. A won dispute never repays the location; the queue shows an open dispute for ever. |
| `account.updated` | Onboarding never completes — a tenant who has finished verification still reads as pending, and payouts stay disabled in our UI. |

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
