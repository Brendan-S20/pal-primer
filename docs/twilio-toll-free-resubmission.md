# Toll-free verification: what to change before resubmitting

Rejected 2026-08-31 (30482, 30507), and again in October (30482, 30474). This
is the diagnosis and the paste-ready text for the resubmission due live by
2026-10-09. Every field under *Paste-ready replacements* is yours to paste into
the Twilio console.

**The filing is account holders only.** The HoundStack toll-free number texts
people who use HoundStack, and nobody else. Texting is not live yet: the pages
say "Text messaging is coming soon and is pending carrier registration." Every
section below was brought in line with that on 2026-10-07. An earlier version
proposed a two-population filing (account holders and the businesses' own
clients); that plan is superseded, and so is any text here that still reads
that way.

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

### The rest of this file

The *Paste-ready replacements*, the app-side items and the 30504 / 30506
sections below were rewritten on 2026-10-07 for the account-holders-only
filing. They no longer describe a second population on this number.

---

# Paste-ready replacements

Everything quoted here matches what is live on 2026-10-07 at
app.houndstack.com/get-started, /legal/sms, /legal/privacy, /legal/terms and
www.houndstack.com. If you change a word on the form, change the page too, or
the mismatch is a rejection of its own (30507).

### Business information (30474 and 30482)

Use these exactly as the site shows them. The footer of www.houndstack.com and
app.houndstack.com, and the top of every /legal page, carry the same sentence:
"HoundStack is operated by The North Consulting LLC, 2222 West Grand River
Avenue STE A, Okemos, MI 48864. Contact: brendan@houndstack.com".

| Field | Value |
|---|---|
| Business name | The North Consulting LLC |
| Brand / DBA | HoundStack |
| Street address | 2222 West Grand River Avenue STE A |
| City, state, ZIP | Okemos, MI 48864 |
| Website | https://www.houndstack.com |
| BusinessContactEmail | brendan@houndstack.com |
| Contact name | Brendan, the named representative. Use the person's own name, not "Support" or "Admin" (see the 30483 trap above). |

Do not put `support@houndstack.com` in `BusinessContactEmail`. It stays as the
HELP contact. No business phone number is published on the site, deliberately.
Use whatever the form requires there, but do not add one to the site.

### Use case description

> HoundStack (operated by The North Consulting LLC) is field service software
> for pet waste removal businesses. This toll-free number sends transactional
> SMS to HoundStack account holders only: the business owners and staff who
> sign in to HoundStack. Messages are verification codes, account and security
> alerts, subscription billing notices, and replies to support requests the
> account holder opened.
>
> Consent is collected through an optional checkbox, unticked by default, on the
> final step of signup at app.houndstack.com/get-started, next to an optional
> mobile number field. The account is created whether or not the box is ticked.
> The exact consent wording, the phone number and a timestamp are stored on the
> account record.
>
> This number is not used for marketing and is not used to message account
> holders' own customers. STOP, START and HELP are supported; STOP stops all
> further messages from this number. Text messaging is not live yet and is shown
> on our site as coming soon, pending this registration.

### Additional information

> Consent checkbox, quoted verbatim from app.houndstack.com/get-started
> (screenshots 4 and 5) and from app.houndstack.com/legal/sms:
>
> "I agree to receive text messages from HoundStack at the number provided about
> my account and service notifications, including verification codes, security
> alerts and billing notices. Consent is optional and is not a condition of
> purchase — you can create and use a HoundStack account without it. Message
> frequency varies. Message & data rates may apply. Reply STOP to opt out or
> HELP for help."
>
> The box is unticked by default and is not a condition of signup or of
> purchase. Our Terms of Service and Privacy Policy each state that accepting
> them does not give consent to receive text messages. The privacy policy states
> that mobile numbers and SMS consent records are collected only from account
> holders who opt in and are not shared with or sold to third parties or
> affiliates for marketing.

### Sample messages

Account-holder messages only. The STOP and HELP replies are the live strings in
`src/lib/platform-inbound.server.ts`. The first four are the registered message
types: no code sends them yet (see "Who the toll-free number texts now" above),
so write the real templates to match these when they are built.

> HoundStack: your verification code is 481920. It expires in 10 minutes. Do not share this code with anyone.
>
> HoundStack: a new sign-in to your account from a new device. If this was not you, reset your password at app.houndstack.com. Reply STOP to opt out or HELP for help.
>
> HoundStack: the card on file for your HoundStack subscription was declined. Update it at app.houndstack.com/settings/billing to avoid interruption. Reply STOP to opt out or HELP for help.
>
> HoundStack support: we have replied to your request about importing clients. See the reply in your email or at app.houndstack.com. Reply STOP to opt out or HELP for help.
>
> HoundStack: You are unsubscribed from HoundStack account messages and will receive no further texts from this number. Reply START to resubscribe or HELP for help.
>
> HoundStack: Account messages for people who use HoundStack: sign-in codes, security alerts and billing notices. For help contact support@houndstack.com. Msg & data rates may apply. Reply STOP to opt out.

### Privacy policy URL

> https://app.houndstack.com/legal/privacy

### Terms and conditions URL

> https://app.houndstack.com/legal/terms

### Opt-in policy proof

All of these load logged out and were re-captured from production on
2026-10-07 (`scripts/capture-sms-opt-in.mjs https://app.houndstack.com`):

```
https://app.houndstack.com/get-started
https://app.houndstack.com/legal/sms
https://app.houndstack.com/sms-opt-in/3-finish-no-number.png
https://app.houndstack.com/sms-opt-in/4-opt-in-unticked.png
https://app.houndstack.com/sms-opt-in/5-opt-in-ticked.png
https://app.houndstack.com/sms-opt-in/6-sms-policy.png
https://app.houndstack.com/sms-opt-in/7-terms.png
https://app.houndstack.com/sms-opt-in/8-privacy.png
```

There is no screenshot 9. The customer portal opt-in that an earlier version
asked for belongs to a business's own clients, who are not on this number, so
it is not evidence for this filing and should not be submitted with it.

---

# App-side items

### The lifecycle texts do not identify the sender (moved, not fixed)

The visit reminder in `messages.functions.ts` reads "Hi Jane, this is a reminder
your visit is scheduled for Tue Sep 2. Reply STOP to opt out." without naming
the business. It no longer leaves the toll-free number at all (see "What a
business's client gets instead"), so it is not part of this filing. It still
matters for the per-business 10DLC registration later: prefix `org.name`
("Acme Pet Waste: hi Jane, …") before those numbers go live.

### The signup consent string contains an em dash

`SMS_CONSENT_TEXT` in `get-started.tsx` has "not a condition of purchase — you
can create…". That would normally fall under the em-dash rule. **Leave it.** It
is the wording on the filing, word for word. It is stored per account as the
consent record and appears in screenshots 4 and 5. Changing it would make the
text quoted to Twilio differ from the page, which is a 30507 mismatch of our
own making. The `em-dash-ok` exemption on it is deliberate.

---

# Two neighbouring rejection codes, and why they no longer apply

## 30504: a single opt-in cannot cover multiple use cases

https://www.twilio.com/docs/api/errors/30504 rejects "combining multiple use
cases under one consent mechanism". This mattered for the two-population plan.
The filing now has one use case (account notifications to account holders) and
one opt-in (the signup checkbox), so there is nothing to combine. Do not add
customer reminders or anything else to the description, or this code comes
back.

## 30506: opt-ins must clearly reflect the end business

Twilio reviews "the business sending messaging (not the software powering
it)". Under the earlier plan, a business's clients would have been texted from
HoundStack's number, and the end business would have been the pet-care
company, not HoundStack. Now the end business and the sender are the same:
HoundStack texts its own account holders, and the opt-in names HoundStack. The
business's clients get texts only from that business's own number, under
per-business 10DLC registration, where each business is its own sender. That is
the split this section used to recommend, and since #341 it is what the code
does.
