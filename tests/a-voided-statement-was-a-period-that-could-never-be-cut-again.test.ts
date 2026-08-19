// A voided statement was a period that could never be cut again — and the
// product told the owner to void one.
//
// Owner decision, 2026-08-19: add "Reopen as draft". Voiding and reopening are
// two deliberate acts.
//
// ── THE LOOP ──────────────────────────────────────────────────────────────
//
// Voiding leaves `status = 'void'` on the row, and the row keeps the unique key
// `(child_organization_id, period_start, period_end)`. `generate_franchise_
// settlements` writes over an existing statement only `WHERE status = 'draft'`,
// so regenerating that period matched the conflict, wrote nothing, and returned
// 0. The zero was reported honestly — and the sentence it was reported in read,
// verbatim:
//
//     "Void an issued statement to recalculate it."
//
// An instruction for something the software cannot do. Following it a second
// time produces the same zero.
//
// Meanwhile the void trigger had already returned that statement's adjustments
// to `pending`, so they were loose: whichever period got generated next swept
// them up. A July chargeback lands on September's statement because July's was
// voided and could never be cut again.
//
// ── WHY THIS NEEDED NO MIGRATION ──────────────────────────────────────────
//
// `setRoyaltyInvoiceStatus` has accepted and authorised `'draft'` since it was
// written. The missing piece was a control, and a sentence that does not send
// somebody round the loop.
//
// Reopening lands the row back in the one state the generator may rewrite —
// and lands it there as a DRAFT rather than recomputing on the way out, so the
// figures are read before they are issued again.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(ROOT + p, "utf8");

/** Comments dropped — block and line, JSX and TypeScript alike.
 *
 *  Stricter than the line-prefix filter the older files use, and it has to be:
 *  every fix in this area is explained in a comment that QUOTES the wrong
 *  behaviour, so "the product no longer says X" is trivially false of the
 *  source and trivially true of the code. Both of the files below contain the
 *  sentence this test exists to remove, inside the comment explaining why it
 *  was removed. */
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

const component = codeOnly(read("src/components/FranchiseSettlementStatements.tsx"));
const route = codeOnly(read("src/routes/_authenticated/franchise.tsx"));
const serverFns = codeOnly(read("src/lib/franchise.functions.ts"));

describe("the comment stripper does not hide the thing being asserted", () => {
  it("removes a JSX comment and keeps the JSX beside it", () => {
    expect(
      codeOnly("{/* Void an issued statement */}\n<Button>Reopen as draft</Button>"),
    ).not.toContain("Void an issued statement");
    expect(codeOnly("{/* x */}\n<Button>Reopen as draft</Button>")).toContain("Reopen as draft");
  });

  it("actually had something to remove in both files", () => {
    // If these ever stop containing the old sentence in prose, the stripper is
    // no longer doing any work and the assertions below get easier for the
    // wrong reason.
    expect(read("src/routes/_authenticated/franchise.tsx")).toContain(
      "Void an issued statement to recalculate it",
    );
    expect(route).not.toContain("Void an issued statement to recalculate it");
  });
});

describe("a voided statement can be put back on the workbench", () => {
  it("offers a reopen control", () => {
    expect(component).toMatch(/Reopen as draft/);
    expect(component).toMatch(/onReopenAsDraft/);
  });

  it("offers it only on a voided statement", () => {
    // On a draft it would be a no-op; on an issued statement it would be a
    // silent un-billing, which is what Void is for and is a deliberate act with
    // its own button.
    const block = component.slice(component.indexOf("onReopenAsDraft &&"));
    expect(block.slice(0, 200)).toMatch(/line\.status === "void"/);
  });

  it("says what reopening does to the adjustments that were on it", () => {
    // The half a status change cannot show. Voiding released them; regenerating
    // draws the still-outstanding ones back. A reader who is not told that
    // reads the next statement as having invented a deduction.
    const block = component.slice(component.indexOf("onReopenAsDraft &&"));
    expect(block.slice(0, 900)).toMatch(/adjustment/i);
    expect(block.slice(0, 900)).toMatch(/released|outstanding/i);
  });

  it("is a 44px target below md, like every other control on this card", () => {
    const block = component.slice(component.indexOf("onReopenAsDraft &&"));
    expect(block.slice(0, 900)).toMatch(/max-md:min-h-11/);
  });

  it("is not offered to the location, which reads statements and does not move them", () => {
    // The component renders each control only when handed its callback, and
    // the location's page passes none. Asserted on the page rather than the
    // component, because that is where the decision lives.
    const page = codeOnly(read("src/routes/_authenticated/settings.franchise.tsx"));
    const mine = page.slice(page.indexOf("function MyStatements"));
    expect(mine.slice(0, mine.indexOf("function MyAdjustments"))).not.toMatch(/onReopenAsDraft/);
  });
});

describe("the parent's page wires it to the status the generator can rewrite", () => {
  it("reopens to draft, not to issued or paid", () => {
    expect(route).toMatch(/onReopenAsDraft=\{\(invoiceId\) =>[\s\S]{0,120}status: "draft"/);
  });

  it("goes through the server function that authorises the change", () => {
    // Not a direct table write. setRoyaltyInvoiceStatus re-resolves the org
    // through requirePermission('manage_franchise') + the Enterprise
    // entitlement and pins the update to `parent_organization_id`, which is the
    // whole of the authorization for this act.
    expect(route).toMatch(/setStatus\.mutate\(\{ invoiceId, status: "draft" \}\)/);
    const fn = serverFns.slice(serverFns.indexOf("export const setRoyaltyInvoiceStatus"));
    expect(fn.slice(0, 1400)).toMatch(/z\.enum\(\["draft", "issued", "paid", "void"\]\)/);
    expect(fn.slice(0, 1400)).toMatch(/resolveOrgId\(context\.supabase, context\.userId\)/);
    expect(fn.slice(0, 1400)).toMatch(/\.eq\("parent_organization_id", orgId\)/);
  });
});

describe("the toast stops instructing an impossible recovery", () => {
  const onSuccess = route.slice(route.indexOf("const generate = useMutation"));
  const block = onSuccess.slice(0, onSuccess.indexOf("const setStatus"));

  it("finds the generate handler at all", () => {
    expect(block.length).toBeGreaterThan(0);
    expect(block).toMatch(/toast\.info/);
  });

  it("no longer tells the owner to void a statement to recalculate it", () => {
    expect(
      block,
      "the zero-generated toast still sends the owner round a loop that always returns zero",
    ).not.toMatch(/[Vv]oid an issued statement to recalculate/);
  });

  it("names the act that actually recovers a period", () => {
    expect(block).toMatch(/[Rr]eopen/);
  });

  it("still tells the truth about why nothing was generated", () => {
    // Zero is a real outcome and reporting it as success is how an owner walks
    // away believing a rate change took effect.
    expect(block).toMatch(/Nothing generated for/);
    expect(block).toMatch(/toast\.success\(/);
  });
});
