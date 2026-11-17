// #972: /platform/addons listed only submitted, in-review and approved
// filings. A rejected or stopped filing left the queue and lived only in an
// email to admins, so a fix could miss Twilio's seven-day priority window.
//
// Now the queue lists rejected and failed filings too, with business name,
// legal name, Twilio's reason, the resubmit-by date and the last error, never
// a SID, token or EIN, sorted by the resubmit deadline first. And the owner's
// Settings → Texting says the same reason in plain words with what to fix,
// for the codes carriers use most.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ADVISED_CODES,
  needsOwnerFix,
  QUEUE_STATUSES,
  rejectionAdvice,
  sortTextingQueue,
} from "@/lib/texting-rejection";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

vi.mock("@tanstack/react-start", () => {
  const builder = {
    middleware: () => builder,
    inputValidator: () => builder,
    handler: (fn: unknown) => fn,
  };
  return { createServerFn: () => builder, createServerOnlyFn: (fn: unknown) => fn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

/** The registration rows as the service role reads them, SIDs included, so a
 *  leak would show. */
const REGS = [
  {
    organization_id: "org-review",
    status: "in_review",
    legal_name: "Review LLC",
    phone_number: "+18445550100",
    submitted_at: "2026-11-01T10:00:00Z",
    approved_at: null,
    ops_approved_at: null,
    last_error: null,
    rejection_reason: null,
    rejection_code: null,
    resubmit_deadline: null,
    subaccount_sid: "AC" + "1".repeat(32),
    verification_sid: "HH" + "1".repeat(32),
  },
  {
    organization_id: "org-late",
    status: "rejected",
    legal_name: "Late Deadline LLC",
    phone_number: "+18445550101",
    submitted_at: "2026-10-01T10:00:00Z",
    approved_at: null,
    ops_approved_at: null,
    last_error: null,
    rejection_reason: "Terms of Service URL is missing SMS terms.",
    rejection_code: "30493",
    resubmit_deadline: "2026-11-24T00:00:00Z",
    subaccount_sid: "AC" + "2".repeat(32),
  },
  {
    organization_id: "org-soon",
    status: "rejected",
    legal_name: "Soon Deadline LLC",
    phone_number: null,
    submitted_at: "2026-11-10T10:00:00Z",
    approved_at: null,
    ops_approved_at: null,
    last_error: null,
    rejection_reason: "Business email requires an official domain.",
    rejection_code: "30482",
    resubmit_deadline: "2026-11-19T00:00:00Z",
  },
  {
    organization_id: "org-failed",
    status: "failed",
    legal_name: "Stopped LLC",
    phone_number: null,
    submitted_at: "2026-11-05T10:00:00Z",
    approved_at: null,
    ops_approved_at: null,
    last_error: "Twilio has no toll-free numbers available right now. Try again later.",
    rejection_reason: null,
    rejection_code: null,
    resubmit_deadline: null,
  },
];
let statusFilter: string[] = [];

vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => {
    const q: any = {};
    q.select = () => q;
    q.order = () => q;
    q.in = (col: string, vals: string[]) => {
      if (table === "org_texting_registrations" && col === "status") statusFilter = vals;
      return q;
    };
    q.then = (res: (v: unknown) => unknown) => {
      if (table === "org_texting_registrations")
        return Promise.resolve({
          data: REGS.filter((r) => statusFilter.includes(r.status)),
          error: null,
        }).then(res);
      if (table === "organizations")
        return Promise.resolve({
          data: REGS.map((r) => ({ id: r.organization_id, name: `${r.legal_name} (trading)` })),
        }).then(res);
      return Promise.resolve({ data: [] }).then(res);
    };
    return q;
  };
  return { supabaseAdmin: { from } };
});

async function list() {
  const { listTextingReviews } = await import("@/lib/texting-ops.functions");
  const handler = listTextingReviews as unknown as (a: unknown) => Promise<{ rows: any[] }>;
  return handler({
    context: { userId: "admin", supabase: { rpc: async () => ({ data: true, error: null }) } },
  });
}

describe("the admin queue", () => {
  it("lists rejected and failed filings as well as those under review", async () => {
    const { rows } = await list();
    expect(statusFilter.sort()).toEqual(
      ["approved", "failed", "in_review", "rejected", "submitted"].sort(),
    );
    expect(rows.map((r) => r.organizationId).sort()).toEqual(
      ["org-failed", "org-late", "org-review", "org-soon"].sort(),
    );
  });

  it("sorts by the resubmit deadline first, soonest first, then by submitted", async () => {
    const { rows } = await list();
    expect(rows.map((r) => r.organizationId)).toEqual([
      "org-soon",
      "org-late",
      // No deadline: oldest submitted first, as the queue always was.
      "org-review",
      "org-failed",
    ]);
  });

  it("carries the business name, legal name, reason, code, deadline and last error", async () => {
    const { rows } = await list();
    const soon = rows.find((r) => r.organizationId === "org-soon");
    expect(soon).toMatchObject({
      businessName: "Soon Deadline LLC (trading)",
      legalName: "Soon Deadline LLC",
      status: "rejected",
      rejectionReason: "Business email requires an official domain.",
      rejectionCode: "30482",
      resubmitDeadline: "2026-11-19T00:00:00Z",
    });
    expect(rows.find((r) => r.organizationId === "org-failed").lastError).toMatch(
      /no toll-free numbers/,
    );
  });

  it("never returns a SID, a token or an EIN", async () => {
    const { rows } = await list();
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/\b(AC|HH|BU|PN|IT)[0-9a-f]{32}\b/);
    expect(text).not.toMatch(/sid|token|ein/i);
    const src = read("src/lib/texting-ops.functions.ts");
    const select = /\.select\(\s*"([^"]*)"/.exec(
      src.slice(src.indexOf("org_texting_registrations")),
    )![1];
    expect(select).not.toMatch(/sid|token|ein/);
  });

  it("a filing waiting on the owner has nothing to activate", () => {
    expect(QUEUE_STATUSES).toEqual(["submitted", "in_review", "approved", "rejected", "failed"]);
    expect(needsOwnerFix("rejected")).toBe(true);
    expect(needsOwnerFix("failed")).toBe(true);
    expect(needsOwnerFix("in_review")).toBe(false);
    const page = read("src/routes/platform.addons.tsx");
    expect(page).toMatch(
      /\{fix \? \(\s*<span[^>]*>Waiting on the owner<\/span>\s*\) : \(\s*<Button/,
    );
    expect(page).toMatch(/Resubmit by \{formatDay\(r\.resubmitDeadline\)\}/);
    expect(page).toMatch(/Twilio: \{r\.rejectionReason\}/);
    expect(page).toMatch(/Last error: \{r\.lastError\}/);
  });
});

describe("sortTextingQueue", () => {
  it("puts every row with a deadline ahead of every row without, and keeps ties stable by submit", () => {
    const rows = [
      { id: "a", resubmitDeadline: null, submittedAt: "2026-11-01" },
      { id: "b", resubmitDeadline: "2026-11-30", submittedAt: "2026-11-02" },
      { id: "c", resubmitDeadline: "2026-11-20", submittedAt: "2026-11-03" },
      { id: "d", resubmitDeadline: null, submittedAt: "2026-10-01" },
      { id: "e", resubmitDeadline: null, submittedAt: null },
    ];
    expect(sortTextingQueue(rows).map((r) => r.id)).toEqual(["c", "b", "d", "a", "e"]);
  });
});

describe("what the owner is told to fix", () => {
  it.each([
    ["30482", /own domain/, /Business email/],
    ["30483", /real person/, /Authorized contact/],
    ["30493", /Terms page/, /STOP opts out/],
    ["30507", /How clients agree/, /appointment, visit and billing texts/],
    ["30527", /legal name and EIN/, /exactly as it appears on your IRS EIN letter/],
  ])("%s", (code, title, fix) => {
    const a = rejectionAdvice(code, null)!;
    expect(a.title).toMatch(title);
    expect(a.fix).toMatch(fix);
    expect(a.fix).toMatch(/resubmit\.$/i);
  });

  it("a registration number mismatch in Twilio's words is read as one, whatever its code", () => {
    for (const reason of [
      "The Business Registration Number does not match the business name.",
      "EIN could not be validated against the legal business name",
      "Business registration number is invalid",
    ]) {
      expect(rejectionAdvice(null, reason)?.title).toMatch(/legal name and EIN/);
    }
  });

  it("says nothing invented for a code it has no advice for", () => {
    expect(rejectionAdvice("30513", "Opt-in image missing")).toBeNull();
    expect(rejectionAdvice(null, null)).toBeNull();
    expect(ADVISED_CODES).toEqual(["30482", "30483", "30493", "30507", "30527"]);
  });

  it("Settings → Texting shows it under a rejected filing's status", () => {
    const page = read("src/routes/_authenticated/settings.sms.tsx");
    expect(page).toMatch(
      /status === "rejected" && \(\s*<TextingRejectionAdvice code=\{reg\?\.rejection_code\} reason=\{reg\?\.rejection_reason\} \/>/,
    );
  });
});
