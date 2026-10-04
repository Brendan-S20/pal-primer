# App Store submission: HoundStack for iPhone and iPad

Last updated 2026-10-04. **This repo records no App Review submission.** Builds
reach TestFlight through Xcode Cloud (internal and external groups; see
`docs/owner-actions-before-submission.md` §3). This is a draft for the owner to
review, edit and submit.

Owner decision (2026-08-20): the iOS app is a **free companion app for
organizations that already exist**. HoundStack's SaaS subscription stays
web-sold. No Apple In-App Purchase is implemented, and none is to be added
without an explicit decision.

---

## 1. The review risk, and what was done about it

This is the part to read before the copy.

Two kinds of money move through HoundStack, and App Store Review treats them as
opposites:

| | what it is | Apple's position | in the iOS app |
|---|---|---|---|
| A homeowner pays a pet-waste company for pet-waste removal | a real-world service, performed at a physical address by a person with a truck | **outside** In-App Purchase, by Apple's own rules on physical goods and services | **kept, and working** |
| An organization pays HoundStack for HoundStack | digital software sold to the person holding the phone | the thing Apple expects to go through IAP if it happens inside the binary | **removed from the binary** |

`src/lib/app-store-billing.ts` holds the decision. On a store platform the app
hides everything that starts or changes a HoundStack purchase:

- the plan picker
- the inline Stripe Payment Element checkout for a plan
- platform add-on subscribe and cancel
- the card on file that pays HoundStack

It keeps read-only account status (which plan, trial state, next invoice),
because that is a fact about the account rather than a call to action, and it
shows a line saying billing is managed on the web. That line is **not** a
tappable link to a purchase flow.

**What is deliberately NOT hidden:** the invoice payment form a technician or
office user uses to take a homeowner's payment, and the saved-card setup for a
homeowner's card. Those are payments for pet-waste removal. Removing them would
break the operational point of the app and would not satisfy any Apple rule.

There is a subtlety a reviewer will not see but a future developer will hit:
`createAddonSubscription` sells a *service* to the org's own client, while
`subscribePlatformAddon` buys *software* from HoundStack. They read almost
identically at a call site and land on opposite sides of this line. Twelve
tests in `tests/the-app-store-would-have-seen-a-subscription.test.ts` pin both
directions and are mutation-checked.

---

## 2. Metadata draft

**App name** (30 char limit)
```
HoundStack
```

**Subtitle** (30 char limit)
```
Field ops for pet waste crews
```
(29 characters.)

**Promotional text** (170 char limit, editable without review)
```
Your routes, stops and photos on the truck. Works with no signal and syncs when you get it back.
```

**Description**

```
HoundStack is the field app for pet-waste removal businesses that already run
on HoundStack. Sign in with your existing account and your day is on your
phone.

FOR THE CREW
• Today's route, in order, with the drive between stops
• Start, complete or skip a stop in one tap
• Photos of finished work, gate conditions and anything that needs saying
• Gate codes, dog names and yard notes where you need them
• Works with no signal. Everything you do is saved on the phone and syncs
  itself when you have service again.

FOR THE OFFICE
• Clients, properties and service history
• Scheduling and dispatch across your technicians
• Invoices, payments and account credits
• The customer portal your clients already use

ON iPad
Built for the bigger screen, including Split View, so the office side works
next to whatever else you have open.

REQUIREMENTS
HoundStack is for businesses with an existing HoundStack organization and for
the people they invite. The app is free. Plans are managed at
app.houndstack.com.
```

**Keywords** (100 char limit, comma separated, no spaces after commas)
```
pooper scooper,dog waste,pet waste,field service,route,dispatch,scooper,kennel,yard cleanup,crew
```
(96 characters.)

**Category** (set in App Store Connect by the owner, 2026-09-15)
- Primary: **Productivity**
- Secondary: **Business**

**Age rating:** 4+

**Support URL:** `https://houndstack.com/contact`
**Marketing URL:** `https://houndstack.com`
**Privacy Policy URL:** `https://houndstack.com/privacy`

> All three verified live on 2026-08-20: `houndstack.com`, `/contact` and
> `/privacy` each return 200 (with and without a trailing slash, and on the
> `www` host). Worth re-checking at submission time rather than trusting this
> line: the first attempt against `/privacy` returned a transport failure and
> passed on retry, so a single red result here is not proof of a broken page.

**Copyright:** `2026 The North Consulting`

---

## 3. App Review notes

Paste into App Review Information → Notes.

```
WHAT THIS APP IS

HoundStack is a business-to-business field-service app for pet-waste removal
companies. It is a companion to our web product at app.houndstack.com. It is
free, and it is only useful to someone whose company already has a HoundStack
organization and who has been invited to it. There is no consumer signup in
the app.

DEMO ACCOUNT

A demo organization with realistic data is provided in the credentials fields.
Signing in with it shows a full week of routes, clients and invoices.

ABOUT PAYMENTS IN THIS APP

The app contains payment screens, and we want to be direct about what they
are, because there are two different things and only one of them is a digital
purchase.

1. PAYMENTS THE APP DOES TAKE are a homeowner paying a pet-waste removal
   company for pet-waste removal. That is a physical service performed at the
   customer's address by a person with a truck. Under guideline 3.1.5(a) and
   Apple's rules on physical goods and services, these are handled outside
   In-App Purchase, through the business's own Stripe account. HoundStack is
   the software the business uses to invoice and collect; the money goes to
   the business, not to us.

2. PAYMENTS THE APP DOES NOT TAKE are subscriptions to HoundStack itself.
   Our own SaaS plans are sold only on the web. Inside this app there is no
   way to subscribe, upgrade, downgrade, buy an add-on, or add a payment
   method for a HoundStack plan. The billing screen shows the organization's
   current plan as read-only information and states that billing is managed on
   the web. There is no purchase link.

No In-App Purchase products are configured for this app.

PERMISSIONS

- Camera: technicians photograph completed work and DNA sample collections and
  attach them to a visit record.
- Photo library: attaching an existing picture to a visit or property.
- Location, when in use only, never in the background: showing the
  technician's own position on the route map relative to the next stop. If
  the business turns on live tracking (off by default), the technician's
  approximate position, rounded to about 100 meters, is shown to the one
  customer they are driving to, from the on-my-way message until the visit
  starts, for at most two hours and only while the app is open. Only the
  latest position is kept, and it is deleted when the visit starts. The
  technician can stop it at any time. This matches the Info.plist string and
  the privacy policy. It is not used for advertising or for tracking in
  Apple's sense (linking with other companies' data).
- Notifications: alerts staff to things that need them, such as a customer's
  text that needs a reply or a gate marked do-not-enter. Never marketing.

OFFLINE

The app is built to work without signal, because driveways and back yards
often have none. Work performed offline is stored on the device and synced
when connectivity returns.
```

**Demo account:** must be supplied by the owner. The demo organization exists
(`seed_demo_org`). Confirm before submitting that the credentials are live,
that the org has a populated week of visits, and that the account is an
**owner** so the reviewer can see both the crew and office sides.

> Do not use a real customer's organization. Do not use
> `detroitdoodisposal@gmail.com`.

---

## 4. Screenshots required

Apple requires one set per device family. Uploading the 6.9" and 13" sets
covers the rest by scaling, which is what most apps do now.

**iPhone 6.9" (1320 x 2868 portrait)** — required
1. Today's route, list with stops in order
2. The route map with stops and the technician's position
3. A visit open, with the photo and complete controls
4. My Day with the 7-day strip
5. The offline banner with the last-synced day (turn on airplane mode)

**iPad 13" (2064 x 2752 portrait)** — required if the app supports iPad, which
it does
1. Clients list beside a client detail
2. Scheduling and dispatch
3. Invoices
4. Route map at full width

**Notes**
- Take them on a real device or the simulator at those exact sizes.
- Use the **demo organization**, never a real client's data. Gate codes, home
  addresses and phone numbers appear on these screens; a QA finding earlier in
  this project was exactly this leak in a full-page screenshot.
- No status-bar clutter: use a clean battery and signal.

---

## 5. Before you press Submit

```
[x] Apple Developer account active — evidence, not assumption: the App Store
      Connect record below exists and Xcode Cloud distributes builds to two
      TestFlight groups, neither of which an inactive membership allows.
[x] Bundle ID consulting.thenorth.houndstack registered — confirmed in App
      Store Connect 2026-08-24. App record exists (Apple ID 6804336787, SKU
      consulting.thenorth.houndstack). The record was created THROUGH Xcode
      Cloud, which matters for the workflow trap in docs/ios-build.md.
      Categories were Business / Utilities when this was written on 2026-08-24;
      the owner set them to **Productivity then Business** on 2026-09-15, which
      is what §5 of docs/owner-actions-before-submission.md had been asking for.
[x] App Privacy questionnaire (the privacy "nutrition label") answered in App
      Store Connect by the owner — docs/owner-actions-before-submission.md §4
[ ] Push: the code shipped in #322 (entitlement, AppDelegate token forwarding,
      the APNs sender) and the APNs key and five APNS_* secrets are set
      (2026-10-03). Left for the owner: tick Push Notifications on App ID
      consulting.thenorth.houndstack, install the first TestFlight build made
      after #322, and receive one on a phone (docs/ios-build.md › Push
      notifications › Owner checklist, steps 3–5). No device had registered in
      production on 2026-10-04.
[ ] App icon renders correctly at every size in Xcode's asset preview
[ ] Device QA checklist in docs/ios-build.md worked through on real hardware
[ ] Billing screen confirmed on a device to show no purchase path
[ ] Staff invoice payment confirmed WORKING on a device
[ ] Demo account created, populated, and tested by signing in fresh
[ ] Screenshots taken from the demo org only
[x] Support, marketing and privacy URLs all resolve — re-checked 2026-10-04:
      houndstack.com, /contact and /privacy each answer 200 (via a redirect to
      www). Worth one more look on submission day, per the note in §2.
[x] Export compliance answered — `ITSAppUsesNonExemptEncryption = false` is in
      ios/App/App/Info.plist as of 2026-08-25, so App Store Connect stops asking
      per build. Answer if prompted anyway: "None of the algorithms mentioned
      above". Evidence rather than assumption: the shipped web bundle from a
      Release build (378 files) contains createCipheriv, createDecipheriv,
      aes-256 and CryptoJS in ZERO files. The createCipheriv hits in src/ are
      all `.server.ts` — Twilio signature checks and secret storage that run on
      the server, never in the binary. The only crypto in the bundle is
      crypto.subtle, which IS the encryption inside Apple's OS, so it is
      "using or accessing" it rather than "in addition to" it.
[ ] TestFlight build installed and opened on your own phone first
```

**Do not submit until the owner explicitly approves.**
