// Four leftovers from the same 2026-08-19 survey, and they are one fault told
// four times: the platform console already had the value in hand and dropped it
// on the floor. None of them needed a query, a column or a migration — each was
// a field already being selected, returned and thrown away by the component
// that received it.
//
// ── 1. AN OVERRIDE NOBODY HAD TO EXPLAIN ──────────────────────────────────
//
// `platform_org_feature_flags.justification` has existed since the table was
// created (20260704040832). `setTenantFeatureFlag` validates it —
// `justification: z.string().max(500).optional().nullable()` — and writes it.
// `listTenantFeatureFlags` returns it on every row, and `TenantFlagRow` has
// carried the field the whole time.
//
// The Feature flags tab sent `{ key, value }` and rendered everything on the
// row except `f.justification`. So the column was NULL for every override ever
// made, and the answer to "why does this one tenant have the beta on" lived in
// whoever's memory. The toggle also said nothing at all afterwards: a per-tenant
// capability change, one unconfirmed click, no toast, on the page whose other
// destructive action makes you type the organization's name.
//
// ── 2. THE PDF NOBODY COULD REACH ─────────────────────────────────────────
//
// `listTenantInvoices` selects `invoice_pdf` and `TenantInvoiceRow` declares
// it. The Invoices tab rendered `hosted_invoice_url` and nothing else — and the
// PDF is the thing an admin is asked for when a tenant queries a charge.
//
// ── 3. AN EMAIL CHANGE WITH NO VISIBLE EFFECT ─────────────────────────────
//
// `getPlatformUserDetail` returns `email_confirmed_at`. The user dialog showed
// email, phone, created, last sign-in — not that. And "Change email" calls
// `updateUserById(..., { email_confirm: true })`, so confirming the address is
// the side effect of the one email action on the page, and it was invisible
// both before and after.
//
// ── 4. AN AUDIT LOG WRITTEN IN ENUM ───────────────────────────────────────
//
// `humanizeAuditAction` was added for the H2 finding — "the audit UI rendered
// raw enums" — with a table of labels including `soft_delete_tenant` →
// "Deleted tenant (soft)". It had NO caller anywhere in src/, and the tenant
// Audit tab rendered `{r.action}`. The fix for the finding shipped and was
// never wired to the screen the finding was about.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { humanizeAuditAction } from "../src/lib/humanize";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(ROOT + p, "utf8");

const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");

const tenantFns = read("src/lib/platform-tenant.functions.ts");
const directoryFns = read("src/lib/platform-directory.functions.ts");
const detailRoute = codeOnly(read("src/routes/platform.tenants.$id.tsx"));
const usersRoute = codeOnly(read("src/routes/platform.users.tsx"));

describe("a feature-flag override records why", () => {
  it("the premise: the server takes a justification and hands it back", () => {
    expect(tenantFns).toMatch(/justification: z\.string\(\)\.max\(500\)\.optional\(\)\.nullable\(\)/);
    expect(tenantFns).toMatch(/justification: ov\?\.justification \?\? null/);
  });

  it("the console sends one", () => {
    expect(detailRoute).toMatch(/justification: input\.justification \?\? null/);
    expect(detailRoute).toMatch(/id="flag-justification"/);
  });

  it("the console shows the one already stored", () => {
    // Without this the field is write-only, which is the same defect with an
    // extra step.
    expect(detailRoute).toMatch(/f\.justification && \(/);
  });

  it("confirms the override by naming the flag and the tenant", () => {
    expect(detailRoute).toMatch(
      /Turn \{pending\?\.flag\.label\} \{pending\?\.value \? "on" : "off"\} for \{tenantName\}\?/,
    );
    expect(detailRoute).not.toMatch(/Are you sure/i);
  });

  it("says what happened, naming the flag and the tenant", () => {
    expect(detailRoute).toMatch(/toast\.success\(/);
    expect(detailRoute).toMatch(/is now \$\{v\.value \? "on" : "off"\} for \$\{tenantName\}/);
  });

  it("confirms clearing an override with the default it falls back to", () => {
    expect(detailRoute).toMatch(/Clear the \$\{f\.label\} override for \$\{tenantName\}\?/);
    expect(detailRoute).toMatch(/back to the platform default/);
  });

  it("gives the 20px switch a 44px box to be tapped in", () => {
    // ui/switch.tsx is h-5 w-9 at every width and is used in ~20 places, so
    // the touch floor goes around this one rather than into the component —
    // the ui/dialog.tsx pattern of a small glyph centred in a big box.
    expect(detailRoute).toMatch(/htmlFor=\{`flag-\$\{f\.key\}`\}[\s\S]{0,160}min-h-11 min-w-11/);
  });
});

describe("a tenant invoice offers its PDF", () => {
  it("the premise: the server selects it and types it", () => {
    expect(tenantFns).toMatch(/invoice_pdf: string \| null/);
    expect(tenantFns).toMatch(/hosted_invoice_url, invoice_pdf/);
  });

  it("the invoices tab renders it", () => {
    expect(detailRoute).toMatch(/r\.invoice_pdf &&/);
  });
});

describe("a user's email says whether it is confirmed", () => {
  it("the premise: the server returns it", () => {
    expect(directoryFns).toMatch(/email_confirmed_at: user\.email_confirmed_at \?\? null/);
  });

  it("the detail dialog renders it", () => {
    expect(usersRoute).toMatch(/d\.email_confirmed_at/);
  });
});

describe("the tenant audit log reads as product copy", () => {
  it("humanizeAuditAction has a caller", () => {
    // It had none. This is the assertion that was false.
    expect(detailRoute).toMatch(/humanizeAuditAction\(r\.action\)/);
  });

  it("and it turns this page's own action names into sentences", () => {
    expect(humanizeAuditAction("soft_delete_tenant")).toBe("Deleted tenant (soft)");
    expect(humanizeAuditAction("suspend_tenant")).toBe("Suspended tenant");
    // This line used to read `.toBe("Restore tenant")`, with the comment
    // "restore_tenant is new and unmapped; the fallback still beats the enum."
    // True at the time, and it is the whole problem in miniature: the fallback
    // is good enough that an unmapped action gets written down as expected
    // behaviour instead of as a gap. It rendered in the present tense directly
    // beneath "Suspended tenant". It now has a real label, along with the
    // eighteen others that were in the same state — see
    // tests/every-audit-action-has-a-label.test.ts, which fails when the next
    // one is added.
    expect(humanizeAuditAction("restore_tenant")).toBe("Restored tenant");
  });
});
