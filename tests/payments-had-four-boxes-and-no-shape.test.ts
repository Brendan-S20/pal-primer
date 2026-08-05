// The Payments page was four embedded Stripe iframes stacked in one column,
// with three more blocks below them that belonged to no group at all.
//
// A first pass (#69) grouped the iframes into Money / Activity / Account tabs
// and moved Disconnect behind a confirm. It left the other three stranded —
// the processing-fee card, a permanently-visible amber warning, and the
// hosted-onboarding fallback all still sat under the tabs. A tab strip with a
// third of the page outside it is not an information architecture; it is a
// decoration on top of the old scroll.
//
// This is the rest of it. Every assertion below is a decision that would
// otherwise be quietly undone by the next person adding "just one more card".

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const page = readFileSync(join(root, "src/routes/_authenticated/payments.tsx"), "utf8");
const server = readFileSync(join(root, "src/lib/stripe-connect.functions.ts"), "utf8");

describe("everything lives in a tab", () => {
  it("the fee setting is behind its own tab, not stacked under the iframes", () => {
    // "Who pays the card fee" is a setting. It was the last thing on a long
    // page, below three dashboards nobody had scrolled past.
    expect(page).toMatch(/settings=\{cfg\.chargesEnabled \? <ProcessingFeeCard \/> : null\}/);
    expect(page).toMatch(/TabsTrigger value="fees"/);
  });

  it("saved-card maintenance sits with the account, not in a warning box", () => {
    expect(page).toMatch(/accountExtras=\{/);
    expect(page).toMatch(/Check saved client cards/);
  });

  it("the fee card is reachable only as the dashboard's settings prop", () => {
    // The stranded blocks were SIBLINGS of <ConnectDashboard>. The first draft
    // of this test sliced from the opening tag and asserted the card did not
    // appear after it — which failed, correctly: the card is passed INTO the
    // dashboard, so of course it appears later in the file. The real claim is
    // that it is rendered exactly once, in the prop.
    const uses = page.match(/<ProcessingFeeCard \/>/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(page).toMatch(/settings=\{cfg\.chargesEnabled \? <ProcessingFeeCard \/> : null\}/);
    // And nothing renders between the dashboard element and the page's close
    // except the conditional fallback link.
    const tail = page.slice(page.indexOf("<ConnectDashboard"));
    expect(tail).not.toMatch(/Switching accounts\?/);
  });
});

describe("warnings only when they are true", () => {
  it("the switching-accounts warning is no longer permanent", () => {
    // It rendered unconditionally, at the foot of the page, warning about a
    // hypothetical whether or not anybody was switching. A warning that is
    // always on screen is one nobody reads.
    expect(page).not.toMatch(/border-amber-300 bg-amber-50[\s\S]{0,200}Switching accounts/);
  });

  it("the hosted-onboarding fallback only shows while setup is unfinished", () => {
    // "Trouble with the embedded steps?" under a completed onboarding offers
    // to fix a problem that cannot exist, and invites people back into a flow
    // they already finished.
    expect(page).toMatch(/\{!cfg\.chargesEnabled && \([\s\S]{0,400}Open Stripe-hosted onboarding/);
  });

  it("the onboarding paragraph only shows before an account is connected", () => {
    expect(page).toMatch(/cfg\?\.connected\s*\?[\s\S]{0,200}Get paid by card and bank transfer/);
  });
});

describe("the balance headline", () => {
  it("reads the CONNECTED account, not the platform's", () => {
    // `stripe.balance.retrieve({ stripeAccount })` puts the account in the
    // params slot, where Stripe ignores it — that call returns the PLATFORM
    // balance and would show every owner HoundStack's money. It belongs in the
    // options argument, like payouts.list below it.
    expect(server).toMatch(/balance\.retrieve\(\{\}, \{ stripeAccount: acct \}\)/);
    expect(server).not.toMatch(/balance\.retrieve\(\{ stripeAccount/);
  });

  it("keeps available and pending apart", () => {
    // One total overstates what can actually be drawn today, which is the
    // number somebody opens this page to find.
    expect(server).toMatch(/available: sum\(/);
    expect(server).toMatch(/pending: sum\(/);
    expect(page).toMatch(/Available now/);
    expect(page).toMatch(/Still clearing/);
  });

  it("sums per currency rather than across them", () => {
    // A connected account can hold several. Adding cents across currencies
    // produces a figure that is wrong in every one of them.
    expect(server).toMatch(/m\.set\(r\.currency/);
  });

  it("calls the payout date an estimate", () => {
    // arrival_date is Stripe's estimate, not a commitment from the bank.
    expect(page).toMatch(/Expected \{new Date/);
  });

  it("stays quiet when the balance cannot be fetched", () => {
    // The embedded Balances and Payouts panels below are authoritative and
    // still work, so an error banner here is noise about a duplicate source.
    expect(server).toMatch(/return \{ connected: true as const, error:/);
    expect(page).toMatch(/if \(!d \|\| !d\.connected \|\| d\.error\) return null/);
  });

  it("is gated on the billing permission", () => {
    expect(server).toMatch(/requirePermission\([\s\S]{0,120}"manage_org_billing"/);
  });
});

describe("disconnect stays hard to do by accident", () => {
  it("is destructive, confirmed, and not beside Refresh", () => {
    expect(page).toMatch(/variant="destructive"[\s\S]{0,400}confirm\(\{/);
    expect(page).toMatch(/title: "Disconnect Stripe\?"/);
    // Refresh is a ghost button in the header; the two are no longer adjacent
    // at identical weight.
    expect(page).not.toMatch(/Refresh\s*<\/Button>\s*<Button[\s\S]{0,120}Disconnect/);
  });
});
