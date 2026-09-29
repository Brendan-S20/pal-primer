// A campaign goes only to who may be emailed.
//
// Nobody could send a seasonal offer, so nobody had to decide who one may
// reach. The rules, in src/lib/campaigns.ts selectAudience:
//
//   * the audience first: active, inactive, or carrying a tag (any case)
//   * then, in this order: unsubscribed, on the imported comms hold, no
//     address, already on the list under another client
//   * an unsubscribe belongs to the ADDRESS as well as the row: two clients
//     sharing an inbox are one person, and if either said no, neither is sent
//
// The last one is the rule most easily lost, because the obvious filter is
// per row and passes every test that has one client per address.
import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_MAX_RECIPIENTS,
  LEADS_ARE_NOT_AN_AUDIENCE_YET,
  audienceSchema,
  matchesAudience,
  selectAudience,
  tagsInUse,
  type AudienceClient,
} from "@/lib/campaigns";

let n = 0;
const client = (over: Partial<AudienceClient> = {}): AudienceClient => {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    display_name: `Client ${String(n).padStart(4, "0")}`,
    primary_email: `client${n}@example.com`,
    active: true,
    tags: [],
    email_opt_out: false,
    comms_paused: false,
    ...over,
  };
};

describe("who a campaign reaches", () => {
  it("leaves out a client who unsubscribed", () => {
    const ok = client();
    const out = client({ email_opt_out: true });
    const r = selectAudience([ok, out], { kind: "active" });
    expect(r.recipients.map((x) => x.clientId)).toEqual([ok.id]);
    expect(r.excluded.optedOut).toBe(1);
  });

  it("leaves out a client on the imported comms hold", () => {
    // A campaign is not a manual send, so the hold an import placed is
    // honoured exactly as enqueueAppEmail honours it for automated mail.
    const ok = client();
    const held = client({ comms_paused: true });
    const r = selectAudience([ok, held], { kind: "active" });
    expect(r.recipients.map((x) => x.clientId)).toEqual([ok.id]);
    expect(r.excluded.commsPaused).toBe(1);
  });

  it("leaves out a client with no address, a blank one, or one that is not an address", () => {
    const ok = client();
    const none = client({ primary_email: null });
    const blank = client({ primary_email: "   " });
    const junk = client({ primary_email: "call me" });
    const r = selectAudience([ok, none, blank, junk], { kind: "active" });
    expect(r.recipients.map((x) => x.clientId)).toEqual([ok.id]);
    expect(r.excluded.noEmail).toBe(3);
  });

  it("sends one email to an address two clients share", () => {
    const a = client({ display_name: "A Household", primary_email: "Shared@Example.com " });
    const b = client({ display_name: "B Household", primary_email: "shared@example.com" });
    const r = selectAudience([b, a], { kind: "active" });
    expect(r.recipients).toHaveLength(1);
    // Stable: always the same row, whatever order the database returned.
    expect(r.recipients[0].clientId).toBe(a.id);
    expect(r.recipients[0].email).toBe("shared@example.com");
    expect(r.excluded.duplicate).toBe(1);
  });

  it("and none at all if EITHER of them unsubscribed", () => {
    // The unsubscribe was answered by an email to the other row, which is the
    // failure this rule exists for.
    const said_no = client({ primary_email: "pat@example.com", email_opt_out: true });
    const other = client({ primary_email: "PAT@example.com" });
    const r = selectAudience([said_no, other], { kind: "active" });
    expect(r.recipients).toEqual([]);
    expect(r.excluded.optedOut).toBe(2);
  });

  it("even when the row that said no is outside the audience", () => {
    // A former client unsubscribed; the same person is an active client under
    // a new row. The opt-out is looked for across every client, not only the
    // ones the audience matched.
    const former = client({ active: false, primary_email: "sam@example.com", email_opt_out: true });
    const current = client({ primary_email: "sam@example.com" });
    const r = selectAudience([former, current], { kind: "active" });
    expect(r.recipients).toEqual([]);
  });

  it("counts every client left out exactly once", () => {
    const list = [
      client(),
      client({ email_opt_out: true, comms_paused: true, primary_email: null }),
      client({ comms_paused: true, primary_email: null }),
      client({ primary_email: null }),
      client({ primary_email: "dup@example.com" }),
      client({ primary_email: "dup@example.com" }),
    ];
    const r = selectAudience(list, { kind: "active" });
    const left =
      r.excluded.optedOut + r.excluded.commsPaused + r.excluded.noEmail + r.excluded.duplicate;
    expect(r.matched).toBe(6);
    expect(r.recipients.length + left).toBe(r.matched);
    expect(r.excluded).toEqual({ optedOut: 1, commsPaused: 1, noEmail: 1, duplicate: 1 });
  });
});

describe("the three audiences", () => {
  const active = client({ tags: ["VIP"] });
  const former = client({ active: false, tags: ["vip ", "Spring-2026"] });
  const untagged = client();

  it("active and inactive are the two halves of the list", () => {
    const all = [active, former, untagged];
    expect(
      selectAudience(all, { kind: "active" })
        .recipients.map((r) => r.clientId)
        .sort(),
    ).toEqual([active.id, untagged.id].sort());
    expect(selectAudience(all, { kind: "inactive" }).recipients.map((r) => r.clientId)).toEqual([
      former.id,
    ]);
  });

  it("a tag matches whatever case and spacing it was typed in, active or not", () => {
    // The same rule as the tag filter and bulk tagging on /clients.
    expect(matchesAudience(active, { kind: "tagged", tag: "vip" })).toBe(true);
    expect(matchesAudience(former, { kind: "tagged", tag: " VIP" })).toBe(true);
    expect(matchesAudience(untagged, { kind: "tagged", tag: "vip" })).toBe(false);
    expect(matchesAudience(active, { kind: "tagged", tag: "vi" })).toBe(false);
  });

  it("the tag list groups spellings under the commonest and counts each client once", () => {
    expect(tagsInUse([active, former, untagged, client({ tags: ["vip", "VIP"] })])).toEqual([
      { tag: "vip", count: 3 },
      { tag: "Spring-2026", count: 1 },
    ]);
  });

  it("a tag audience needs a tag", () => {
    expect(audienceSchema.safeParse({ kind: "tagged", tag: "  " }).success).toBe(false);
    expect(audienceSchema.safeParse({ kind: "tagged", tag: "vip" }).success).toBe(true);
  });

  it("leads are not an audience, and the page says why", () => {
    // campaigns.ts LEADS_ARE_NOT_AN_AUDIENCE_YET: an unconfirmed address, no
    // opt-out column, and nothing to carry an unsubscribe through conversion.
    expect(audienceSchema.safeParse({ kind: "leads" }).success).toBe(false);
    expect(LEADS_ARE_NOT_AN_AUDIENCE_YET).toMatch(/not confirmed/);
  });
});

describe("the cap", () => {
  it("is 5,000, and a larger audience says so rather than being cut short", () => {
    expect(CAMPAIGN_MAX_RECIPIENTS).toBe(5000);
    const many = Array.from({ length: CAMPAIGN_MAX_RECIPIENTS + 1 }, () => client());
    const r = selectAudience(many, { kind: "active" });
    expect(r.recipients).toHaveLength(CAMPAIGN_MAX_RECIPIENTS + 1);
    expect(r.overCap).toBe(true);
    expect(selectAudience(many.slice(1), { kind: "active" }).overCap).toBe(false);
  });
});
