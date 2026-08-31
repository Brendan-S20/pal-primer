# Toll-free verification: what to change before resubmitting

Rejected 2026-08-31 on two codes. This is the diagnosis and the paste-ready
replacement text. Nothing here has been applied — every field below is yours
to paste into the Twilio console, and the two app-side items at the bottom are
flagged rather than changed because they alter what customers actually receive.

## 30482 — Business Email Address Must Use an Official Domain

**Corrected 2026-08-31 against Twilio's own error documentation.** An earlier
version of this file said 30482 was not on the toll-free form at all and pointed
at the Trust Hub Business Profile instead. That was wrong, and it was inference
from a screenshot rather than a reading of the spec.

https://www.twilio.com/docs/api/errors/30482 says the field is
**`BusinessContactEmail`, in the verification request itself**:

> The business email in the verification request uses a free or personal email
> provider instead of your business domain.

`BusinessContactEmail` is one of the submission's business-information fields —
it appears in the same list as `BusinessName`, `BusinessStreetAddress`,
`BusinessWebsite` and the rest (see the field enumeration under error 30472).
The `support@houndstack.com` visible in the screenshot sits lower down, near the
phone number; the business contact email is in the business section above it.
So the Gmail address is on the form, in a part the screenshots did not capture.

**Fix:** set `BusinessContactEmail` to an `@houndstack.com` address.

Two things the docs add that are worth knowing:

- **There is a second, legitimate remedy.** "If you must use a free email
  address, list that address on your official business website as a valid
  business contact before you resubmit." So a Gmail address can pass, provided
  it is published on houndstack.com as a contact method. Setting up mail on the
  domain is still the cleaner answer.
- **Use the resubmit flow, not delete-and-recreate.** From the sibling error
  30452: "Deleting and resubmitting places the request in the same queue as a
  new submission." Correcting the rejected request in place keeps its position.

## 30507 — Opt-In Does Not Match the Use Case

Three separate mismatches. The first is almost certainly the trigger.

### 1. The use case is narrower than the traffic (the real problem)

The submitted description says the number sends

> transactional SMS to account holders only

`PLATFORM_SMS_FROM_NUMBER` is set in production. Every one of these paths reads
`platformTwilioFrom()` first and sends **to a pet-care business's end customer**,
not to a HoundStack account holder:

| What | Where | Recipient |
|---|---|---|
| Visit reminder | `messages.functions.ts:282` (`kind: "reminder"`) | client |
| Technician on the way | same (`kind: "on_my_way"`) | client |
| Visit completed | same (`kind: "completed"`) | client |
| Customer portal sign-in code | `portal-auth.server.ts:329` | portal contact |
| Overdue invoice reminder | `nightly.ts:224` | client |
| Payment-failed alert | `stripe.ts:755` | client |

So "account holders only" is not true in operation. That matters more than the
rejection: a number approved on a description that does not match its traffic
gets blocked *after* approval, which is a worse position than this one.

The description below names both populations. It is defensible because the
consent architecture for the second one is real — see §2.

### 2. The proof you submitted contradicts the description you submitted

The privacy policy URL (`/legal/sms`) and opt-in proof (`6-sms-policy.png`) both
describe the customer population — visit reminders, on-the-way notices, portal
sign-in codes, invoice reminders. The reviewer was pointed at a page that
contradicts "account holders only".

**The page is accurate. The form was wrong.** No page change is needed; the
description is what has to widen.

### 3. The consent text you quoted is not the text the app shows

Submitted in *Additional information*:

> "I agree to receive text messages from HoundStack at the number provided,
> including login codes and service notifications. Msg & data rates may apply.
> Reply STOP to opt out or HELP for help."

Actual string, `src/routes/get-started.tsx:66` — the one in screenshots 4 and 5:

> "I agree to receive text messages from HoundStack at the number provided about
> my account and service notifications. Consent is optional and is not a
> condition of purchase — you can create and use a HoundStack account without it.
> Message frequency varies. Message & data rates may apply. Reply STOP to opt out
> or HELP for help."

The real one is **stronger**: it carries "not a condition of purchase" and
"message frequency varies", both of which carriers look for and neither of which
made it onto the form. Quote it verbatim.

---

# Paste-ready replacements

### Use case description

> HoundStack is a field service platform used by pet waste removal businesses.
> This number sends transactional SMS in two categories, both requiring prior
> express written consent that is recorded before any message is sent.
>
> (1) To HoundStack account holders (business owners and their staff): 2FA and
> verification codes, account and security alerts, subscription billing notices,
> and replies to support requests they opened. Consent is collected via an
> unchecked checkbox on the final step of signup at
> app.houndstack.com/get-started. The account is created whether or not the box
> is ticked. The exact consent wording, the phone number and a timestamp are
> stored on the account record.
>
> (2) To the customers of those businesses: appointment reminders,
> technician-on-the-way and visit-completed notices, sign-in codes for the
> customer portal, and overdue-invoice reminders. These recipients opt in either
> themselves, through a checkbox on their own portal account page, or through a
> consent the business holds and records with an attestation. In both cases
> HoundStack stores the exact wording agreed, the number, the timestamp and the
> source. Every automated send is gated in the database by
> `client_may_be_texted`, which requires a stored consent record and returns
> false for anyone who has replied STOP.
>
> STOP, START and HELP are handled centrally for both categories on this number.
> No marketing or promotional messages are sent from it.

### Additional information

> Account-holder consent checkbox, quoted verbatim from
> app.houndstack.com/get-started (screenshots 4 and 5):
>
> "I agree to receive text messages from HoundStack at the number provided about
> my account and service notifications. Consent is optional and is not a
> condition of purchase — you can create and use a HoundStack account without it.
> Message frequency varies. Message & data rates may apply. Reply STOP to opt out
> or HELP for help."
>
> Customer consent checkbox, quoted verbatim from the customer portal account
> page (screenshot 9):
>
> "I agree to receive service text messages about my appointments, visit updates,
> and billing from this business at the number provided. Consent is not a
> condition of purchase. Message and data rates may apply. Message frequency
> varies. Reply STOP to opt out or HELP for help."
>
> Both boxes are unticked by default and neither is a condition of signup or of
> purchase. Consent text, phone number, timestamp and source are stored per
> record and shown back in the UI for audit. Standard keywords (STOP, START,
> HELP, UNSTOP) are supported and STOP overrides any stored consent.

### Sample messages

Replace with the real templates, which are what actually goes out:

> HoundStack: your verification code is 481920. It expires in 10 minutes. Do not share this code with anyone.
> Hi Jane, this is a reminder your visit is scheduled for Tue Sep 2. Reply STOP to opt out.
> Hi Jane, your tech is on the way for today's visit. Reply STOP to opt out.
> HoundStack: your payment method was declined for your monthly subscription. Update it at app.houndstack.com/settings/billing to avoid interruption. Reply STOP to opt out or HELP for help.

### Terms and conditions URL

Currently blank. `/legal/terms` exists:

> https://app.houndstack.com/legal/terms

### Opt-in policy proof

Add the two you already host and one you need to capture:

```
https://app.houndstack.com/get-started
https://app.houndstack.com/sms-opt-in/4-opt-in-unticked.png
https://app.houndstack.com/sms-opt-in/5-opt-in-ticked.png
https://app.houndstack.com/sms-opt-in/3-finish-no-number.png
https://app.houndstack.com/sms-opt-in/6-sms-policy.png
https://app.houndstack.com/sms-opt-in/7-terms.png
https://app.houndstack.com/sms-opt-in/8-privacy.png
https://app.houndstack.com/sms-opt-in/9-portal-opt-in.png
```

**Screenshot 9 does not exist yet and is the one that answers 30507.** Capture
the customer portal account page — route
`src/routes/portal.$slug.$token.account.tsx`, live at
`/portal/:slug/:token/account` — showing the texting section with the consent
wording visible and the box unticked. That is the opt-in for population (2), and
its absence is why the evidence pack only ever proved population (1).

---

# Two app-side items, flagged not changed

Both alter what customers receive, so they want an explicit decision.

### The lifecycle texts do not identify the sender

`messages.functions.ts:232-237` sends:

> "Hi Jane, this is a reminder your visit is scheduled for Tue Sep 2. Reply STOP to opt out."

From an unrecognised toll-free number, that does not tell the recipient who is
texting them. CTIA guidance wants the sender identifiable in the message, and a
reviewer comparing these samples against a "customer notifications" use case may
well raise it. Prefixing the business name would read:

> "Acme Pet Waste: hi Jane, this is a reminder your visit is scheduled for Tue Sep 2. Reply STOP to opt out."

`org.name` is already loaded on that path.

### The signup consent string contains an em dash

`get-started.tsx:69` has "not a condition of purchase — you can create…". That
is customer-facing copy and would normally fall under the em-dash rule.

**Leave it.** Changing it desyncs the stored consent records (the wording is
stored per account as the evidence), invalidates screenshots 4 and 5, and would
mean the text quoted to Twilio no longer matches the text on the page — which is
mismatch §3 all over again, self-inflicted.

---

# Two rejection codes the resubmission has not accounted for

Found by reading the neighbouring error codes rather than only the two that
fired. Both bear directly on the broadened description above.

## 30504 — a single opt-in cannot cover multiple use cases

https://www.twilio.com/docs/api/errors/30504 rejects "combining multiple use
cases under one consent mechanism" and asks for "separate opt-in mechanisms for
each message type".

The description drafted above names two populations. That is only safe because
the two opt-ins are genuinely separate mechanisms, and the submission has to
make that structural rather than leave it implied:

- **Account holders** consent at signup, on app.houndstack.com/get-started, to
  account and service notifications about their own HoundStack account.
- **A business's customers** consent separately — either themselves on their
  portal account page, or through a consent the business records — to messages
  about their appointments, visits and billing with that business.

Neither box covers the other population, neither is pre-ticked, and neither is a
condition of anything. Say that explicitly. A description that blends them into
one paragraph of "we send transactional messages" is what 30504 exists to catch.

## 30506 — opt-ins must clearly reflect the end business

This is the one to watch, and it is structural rather than a wording fix.
Twilio's review "looks at the business sending messaging (not the software
powering it)". For category (2) the business with the consumer relationship is
the pet-care company, not HoundStack — but the messages leave HoundStack's
toll-free number, and the customer consent string reads:

> "I agree to receive service text messages about my appointments, visit
> updates, and billing **from this business** at the number provided."

"this business" is not a name. On the portal page the business is identifiable
from the surrounding page, which may satisfy a reviewer, but the consent string
alone does not name who is texting. The same gap shows in the messages
themselves — see the sender-identification item below, which is the same problem
seen from the other end.

If a reviewer treats HoundStack as an ISV messaging on behalf of end businesses,
the guidance under 30472 applies and the submission should carry the END
business's details, not the platform's. That is a different shape of submission
from the one in flight, and it is the argument for the narrower option: keep the
toll-free number for HoundStack's own account holders, and move customer traffic
onto per-tenant 10DLC where each business is its own sender. The code already
anticipates exactly that split — `resolveOrgTwilioConfig` provisions a subaccount
per tenant and returns null until 10DLC clears.
