# Device QA script

A checklist for a QA pass on one simulator. One runner per device, working
independently, reporting in the format at the bottom.

## The rule that matters more than the checklist

**Never report a check as passed if you did not observe it.** "Could not test"
is a correct and useful result. A report where "passed" and "not run" look the
same is worthless, and this project has already been burned by the softer
version of that: a browser sweep reported 382 passed / 0 failed on iPad-sized
viewports while measuring a mouse, and the same code failed 105 of them the
moment touch was actually emulated.

Two habits follow from it:

- **Screenshot every visual claim.** A claim with no image is an opinion.
- **Say which build.** `git rev-parse --short HEAD` at the start of the run.
  And which backend: a store-style bundle talks to production unless it was
  built with `npm run build:native:staging`. Acceptance runs on production,
  signed into the production demo org (`organizations.slug` is `demo`,
  `@demo.test` accounts), not a staging build. Use only demo or test records,
  never touch Detroit Doo Disposal's or any other real org's data, and send no
  real customer email or text. The full rules, and how to check you are in
  the demo org, are in `docs/native-qa-staging.md`.

## Setup

Your device UDID is given to you. Everything below uses `$D` for it.

```bash
D=<your-udid>
xcrun simctl bootstatus "$D" -b                  # wait for a real boot
xcrun simctl status_bar "$D" override --time "9:41" --cellularBars 4 --wifiBars 3
xcrun simctl launch "$D" consulting.thenorth.houndstack
sleep 60                                          # SEE "the app renders black" BELOW
xcrun simctl io "$D" screenshot /tmp/qa-$D-boot.png
```

**The app takes 40-60 seconds to paint after a simulator boot, showing pure
black the whole time.** This is not a crash. WebKit logs `didCommitLoadForFrame`
and `didFinishLoadForFrame` throughout. Do not screenshot before 60s and do not
report a black screen as a failure without waiting — that mistake has already
been made once in this repo and written up.

**The simulator wedges after roughly twenty app launches.** Symptoms: `install`
reports success but `get_app_container` finds nothing, `launch` fails, and at
its worst `simctl io screenshot` stops responding. It is CoreSimulator, not the
app. Fix: `xcrun simctl shutdown "$D" && xcrun simctl boot "$D"`. Report it as
an environment event, never as a product defect.

## What to check

Work through these in order. For each: what you did, what you saw, the
screenshot path, and one of PASS / FAIL / NOT RUN.

### 1. Boot and chrome
- App launches and paints.
- The top bar reaches the very top of the screen. There must be no band of
  empty colour above it — that was a real fault (`ios.contentInset`) that cost
  62pt on every screen.
- The status bar clock and the Dynamic Island do not sit on top of any control.
- On a phone: the bottom tab bar is clear of the home indicator.

### 2. Navigation
- Every bottom tab (Home, Schedule, +, Clients, More) opens something.
- The More sheet opens, scrolls, and every row goes somewhere.
- The + sheet shows creates ABOVE a "Jump to" heading, and the creates really
  create: "New client" opens a form, "New invoice" opens a dialog on arrival.

### 3. Touch targets — the iPad question
- Anything you would tap should be at least 44pt. The left sidebar on a tablet
  was a 32px target on every iPad until recently; look hard at it.
- Anything that only appears on hover is unreachable on touch. If a row has a
  delete or an overflow control, it must be visible without hovering.

### 4. Scrolled state
- Scroll a long page (Settings > Billing, Clients, Invoices).
- The sticky header keeps its own strip: page content must not scroll through
  it, and its controls must not slide under the clock.

### 5. Orientation
- Rotate to landscape and back on every surface you visited.
  `xcrun simctl ui "$D" appearance` does NOT rotate; use the Simulator app's
  Device > Rotate, or drive it from a test.
- Nothing may scroll sideways. Wide content scrolls inside its own container;
  the page body does not.

### 6. Forms and dialogs
- Open a dialog (New invoice, One-off visit). It must fit the screen, its
  buttons must be reachable, and the keyboard must not cover the field being
  typed into.
- Dismiss it. Nothing should be left behind covering the app.

### 7. The App Review gate
- Settings > Billing must show the plan and its status.
- It must offer NO way to buy or change a HoundStack plan, and no wording that
  points at a website: no domain, no "on the web", and none of choose / pick /
  upgrade / subscribe / buy / update payment.
- The client's own Billing tab is the opposite case and MUST still take a
  customer's payment. Do not report that as a gate failure.
  On production, check the payment control is there; do not submit a payment.

### 8. Offline
- `xcrun simctl status_bar "$D" override --dataNetwork hide --cellularMode notSupported`
  is cosmetic only; it does not disconnect anything. Real offline needs the
  host's network down, which is out of scope for a single runner — mark
  NOT RUN unless told otherwise.

## What cannot be tested on a simulator

State these as NOT RUN with the reason, never as passed:

- Camera capture landing on a visit (the simulator has no camera).
- Haptics.
- Real airplane mode / genuine loss of connectivity.
- Push notification delivery — the app has no entitlements file, so the
  capability is off and nothing will arrive regardless.
- Split View and Slide Over.

## Reporting

Finish with three clearly separated sections. Do not merge them.

```
BUILD: <short sha>   DEVICE: <name> (<udid>)   <WxH pt>

PASSED
  1. <check> — <what you saw> — <screenshot path>

FAILED
  <check> — <what you saw> — <screenshot path>
  Where: <file:line if you found it, otherwise "not located">

NOT RUN
  <check> — <why>
```

Keep FAILED entries specific enough to act on: the surface, the width, the
control, and a measurement where one is possible. "Looks cramped" is not a
finding; "the Complete button is 25pt tall on the stop card at 402pt" is.
