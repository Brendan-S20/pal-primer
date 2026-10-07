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

### Re-verified 2026-09-16 against Twilio's live docs, and one trap found

Checked through the Twilio documentation tools rather than from memory, because
this file rests on a reading of the spec and specs move.

**The substance holds. The quote does not.** Twilio's 30482 page was modified
**2026-09-14**, two weeks after this file was written, and the description has
been reworded. It now opens:

> This error occurs when the business email in a Toll-Free verification
> submission **cannot be verified as associated with the business**. Use the
> official business domain where available.

rather than the "uses a free or personal email provider instead of your business
domain" quoted above. Softer framing, same requirement, and the second remedy
this file already records — publishing a free address on the site — is still
there verbatim. Nothing below needs changing. The quoted line is simply no
longer word-for-word, which matters only if somebody goes looking for it.

**The trap: the obvious fix for 30482 can trigger 30483.** Error 30483,
"Contact must be a business representative", lists among its causes:

> You entered a generic role or title, such as **Admin or Support**, instead of
> an authorized business representative.

and among its solutions:

> Make sure the contact details you submit belong to that business
> representative, **including `businessContactEmail`**.

So setting `BusinessContactEmail` to `support@houndstack.com` — the obvious
reading of "use an official domain", and the address already visible in the
screenshot — swaps a 30482 rejection for a plausible 30483 one. A shared
mailbox is not the named representative's address.

**Use a person's address on the business domain**, matching the
`businessContactFirstName` / `businessContactLastName` on the same submission.
`support@` is the right address for the HELP response and the wrong one for this
field.

This is inference from two error pages read together, not something Twilio
states as a rule — but it costs one character of care to avoid and a rejection
cycle to discover.

## 30507 — Opt-In Does Not Match the Use Case

**Rewritten 2026-10-06, when the code was changed to match the resubmission.**
An earlier version of this section said the traffic was wider than the
description and proposed widening the description to two populations. The
resubmission went the other way: it narrows the TRAFFIC. The toll-free number
texts account holders only, and the code now does exactly that.

### What the rejection was about

The first submission said the number sends "transactional SMS to account
holders only". In operation it did not. Every automated text to a pet-care
business's client chose its sender as `platformTwilioFrom() ??
org.sms_from_number`, which prefers the platform number, and `sendTwilioSms`
fell back to the platform's own Twilio account (gateway mode) whenever a call
left `credentials` out. Reminders, on my way, visit completed, overdue
invoices, a declined card and customer portal sign-in codes all left
HoundStack's toll-free number for people who are not HoundStack account
holders. A description its traffic contradicts is a rejection at best, and a
block after approval at worst.

### Who the toll-free number texts now

**Account holders, and nobody else**: the people who sign in to HoundStack.
Verification codes, security alerts, billing notices to the business, and
support replies. Only `platformAccountHolderFrom()` names the number, and
only gateway mode with a declared `purpose: "account_holder"` sends on the
platform's account (`src/lib/twilio-credentials.server.ts`,
`src/lib/twilio.server.ts`). There is no default any more: a send that does
not say who it is for does not compile, and throws if it is forced through.

Today the codebase has **no** account-holder text at all. Staff two-step
codes go through Supabase Auth's phone factor, which is configured in the
Supabase dashboard rather than in this repo, and billing notices to the
business go by email. The number's only job in code today is answering texts
sent to it (below).

### What a business's client gets instead

A business's client or lead is texted only from **that business's own
subaccount**, through `endCustomerSmsSender(orgId)`. It returns the
subaccount's credentials and number or messaging service, or null. There is
no fallback: not to the platform number, not to gateway mode, and not to the
legacy `organizations.sms_from_number` column, which has no credentials of its
own.

No business has a subaccount yet (provisioning, BUILD-3, waits on carrier
registration), so today every one of these is null and **no client is texted
by anything in this codebase**:

| Message | Where | With no subaccount |
|---|---|---|
| On my way | `on-my-way.server.ts` | email, which was already the fallback |
| Review request, automatic and manual | `my-day.functions.ts`, `reviews.functions.ts` | email |
| Portal sign-in code | `portal-auth.server.ts` | email only; the portal no longer offers "Text me a code", and the company sign-in page asks for an email, not a phone |
| Overdue invoice | `nightly.ts` | the overdue EMAIL the same job already sends; the run log records why no text went |
| Card declined on autopay | `stripe.ts` | no text; the office's in-app notice still goes |
| Visit reminder / completed buttons | `messages.functions.ts` | refused with a plain message; My Day hides its "Text reminder" button |
| Staff-to-client message | `messages.functions.ts` | refused with a plain message |

Production `public.messages` had no rows in the sixty days before the change,
so nothing that was actually being sent stopped.

### Texts sent TO the toll-free number

They are from an account holder or a stranger, never a business's client,
and they are checked for **before** any business is looked up
(`routes/api/public/hooks/twilio.ts`, `lib/platform-inbound.server.ts`).
STOP, START and HELP are answered in HoundStack's name with
support@houndstack.com; Twilio's own opt-out list is what blocks further
texts after STOP. Anything else gets no reply. Nothing is written to any
business's messages, no client record is touched, and no office is notified.
Until this change a reply to that number was routed into the conversation of
whichever business had texted that phone last.

The ENT / DNE handshake that answers "on my way" moved with the text: it now
arrives on the business's own number and is handled on that business's path
(`lib/gate-reply.server.ts`).

### When customer texts come back

When per-business numbers clear carrier registration. Each business then gets
a subaccount under HoundStack's 10DLC brand, `endCustomerSmsSender` stops
returning null for it, and every message in the table above goes out from that
business's own number with no further code change. Customer texting is not a
use case of the toll-free number at any point, before or after.

### What keeps it that way

`tests/the-toll-free-number-texts-account-holders.test.ts` parses `src/` and
fails, naming file and line, on: any call to `platformAccountHolderFrom()`
outside its allowlist (one entry, the inbound webhook), any `{ mode: "gateway" }`
outside its allowlist (empty), any `sendTwilioSms` whose credentials did not
come from `endCustomerSmsSender`, any `from` not taken from that same sender,
and any file that sends without being classified as account-holder or
end-customer. It was mutation-checked by putting
`platformTwilioFrom() ?? org.sms_from_number` back into `on-my-way.server.ts`.
`tests/a-business-client-is-texted-from-the-business-number.test.ts` runs the
senders against a fake fetch and checks what actually goes on the wire.

### What else in this file predates the change

The *Paste-ready replacements* below describe two populations on this number,
and their sample messages include client reminders and on-my-way texts. That
was the earlier plan and is superseded by the account-holders-only filing. The
30506 section's closing recommendation, to keep the toll-free number for
account holders and move customer traffic onto per-tenant 10DLC, is what the
code now does.

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
