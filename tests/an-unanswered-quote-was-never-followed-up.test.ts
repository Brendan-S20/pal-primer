// An unanswered quote was never followed up.
//
// Jobber's quote step is "a quote goes out, with automated follow-ups". A
// quote here sat as "sent" until it expired and nothing reminded anyone. The
// nightly job now sends ONE reminder, a set number of days after sending,
// while the quote can still be accepted.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { render } from "react-email";
import { followupDue } from "@/lib/quote-followups";
import { TEMPLATES } from "@/lib/email-templates/registry";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const NOW = new Date("2026-09-29T15:00:00Z");
const base = {
  status: "sent",
  sent_at: "2026-09-25T15:00:00Z", // four days ago
  valid_until: "2026-10-25",
  followup_sent_at: null,
};
const due = (over: Partial<typeof base> & Record<string, unknown>, days = 3) =>
  followupDue({ ...base, ...over } as any, { days, orgToday: "2026-09-29", now: NOW });

describe("when a quote is followed up", () => {
  it("after the set number of days", () => {
    expect(due({})).toBe(true);
    expect(due({}, 5)).toBe(false);
  });

  it("once", () => {
    expect(due({ followup_sent_at: "2026-09-28T09:00:00Z" })).toBe(false);
  });

  it("only while it is still a question", () => {
    for (const status of ["accepted", "declined", "expired", "draft"]) {
      expect(due({ status }), status).toBe(false);
    }
  });

  it("never about a quote the customer can no longer accept", () => {
    expect(due({ valid_until: "2026-09-28" })).toBe(false);
    expect(due({ valid_until: "2026-09-29" })).toBe(true);
    expect(due({ valid_until: null })).toBe(true);
  });

  it("not at all when the business turned it off", () => {
    expect(due({}, 0)).toBe(false);
  });
});

// ── The sender, against a fake database ─────────────────────────────────────
const updates: Array<{ table: string; payload: unknown; filters: Array<[string, unknown]> }> = [];
let rows: any[] = [];
const sent: any[] = [];
vi.mock("@/lib/email/enqueue.server", () => ({
  enqueueAppEmail: vi.fn(async (p: any) => {
    sent.push(p);
    return { ok: true };
  }),
}));
vi.mock("@/lib/app-origin", () => ({ appOrigin: () => "https://app.example.com" }));

function fakeDb() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let payload: unknown;
      const b: any = {
        select: () => b,
        eq: (k: string, v: unknown) => (filters.push([k, v]), b),
        is: (k: string, v: unknown) => (filters.push([k, v]), b),
        lte: () => b,
        limit: () => Promise.resolve({ data: rows, error: null }),
        update: (p: unknown) => ((payload = p), b),
        then: (res: (v: unknown) => unknown) => {
          if (payload) updates.push({ table, payload, filters });
          return Promise.resolve({ data: null, error: null }).then(res);
        },
      };
      return b;
    },
  };
}

const { sendQuoteFollowups } = await import("@/lib/quote-followups.server");

beforeEach(() => {
  updates.length = 0;
  sent.length = 0;
  rows = [
    {
      ...base,
      id: "q1",
      number: 1001,
      title: "Weekly service",
      public_token: "tok-1",
      client_id: null,
      prospect_name: "Dana Prospect",
      prospect_email: "dana@example.com",
      clients: null,
      quote_line_items: [
        { amount_cents: 2400, recurring: true },
        { amount_cents: 9000, recurring: false },
      ],
    },
    {
      ...base,
      id: "q2",
      number: 1002,
      followup_sent_at: "2026-09-28T09:00:00Z",
      public_token: "t2",
      client_id: null,
      prospect_email: "x@example.com",
      quote_line_items: [],
    },
  ];
});

describe("the nightly sender", () => {
  const org = { id: "org-1", timezone: "America/Chicago", quote_followup_days: 3 };

  it("emails the due quote as a reminder, with its link, and stamps it", async () => {
    const n = await sendQuoteFollowups(fakeDb(), org, NOW);
    expect(n).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      templateName: "quote-sent",
      notifyKey: "notify_email_quote_sent",
      idempotencyKey: "quote-followup-q1",
      toOverride: "dana@example.com",
      templateData: expect.objectContaining({
        reminder: true,
        quoteLabel: "Q-1001",
        oneTimeCents: 9000,
        recurringCents: 2400,
        quoteUrl: "https://app.example.com/q/tok-1",
      }),
    });
    // An automated send: it must respect a client's communications hold.
    expect(sent[0].manual).toBeUndefined();
    expect(updates).toEqual([
      {
        table: "quotes",
        payload: { followup_sent_at: NOW.toISOString() },
        filters: [
          ["id", "q1"],
          ["status", "sent"],
          ["followup_sent_at", null],
        ],
      },
    ]);
  });

  it("stamps a quote with nobody to email, so it is not retried every night", async () => {
    rows = [{ ...rows[0], prospect_email: null }];
    expect(await sendQuoteFollowups(fakeDb(), org, NOW)).toBe(0);
    expect(sent).toHaveLength(0);
    expect(updates).toHaveLength(1);
  });

  it("does nothing when the business turned it off", async () => {
    expect(await sendQuoteFollowups(fakeDb(), { ...org, quote_followup_days: 0 }, NOW)).toBe(0);
    expect(sent).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});

describe("the email and the switch", () => {
  it("reads as a reminder", async () => {
    const t = TEMPLATES["quote-sent"];
    const html = await render(
      React.createElement(t.component, {
        orgName: "Acme Scoop",
        quoteLabel: "Q-1001",
        reminder: true,
      }),
    );
    expect(html).toContain("Still thinking it over?");
    expect(html).toContain("is still waiting for an answer");
    expect(
      (t.subject as (d: any) => string)({
        quoteLabel: "Q-1001",
        orgName: "Acme Scoop",
        reminder: true,
      }),
    ).toBe("Reminder: quote Q-1001 from Acme Scoop");
    expect((t.subject as (d: any) => string)({ quoteLabel: "Q-1001", orgName: "Acme Scoop" })).toBe(
      "Quote Q-1001 from Acme Scoop",
    );
  });

  it("runs from the nightly job, and the owner can change or turn it off", () => {
    const nightly = read("src/routes/api/public/hooks/nightly.ts");
    expect(nightly).toMatch(/quote_followup_days"/);
    expect(nightly).toMatch(/sendQuoteFollowups\(supabaseAdmin, org\)/);
    const page = read("src/routes/_authenticated/settings.emails.tsx");
    expect(page).toMatch(/Follow up on an unanswered quote/);
    expect(page).toMatch(/<option value=\{0\}>Never<\/option>/);
    const mig = read(
      "supabase/migrations/20260929020000_an-unanswered-quote-was-never-followed-up.sql",
    );
    expect(mig).toMatch(/quote_followup_days smallint NOT NULL DEFAULT 3/);
  });
});
