// The royalty is charged on money the location never receives, and nothing
// said so.
//
// Owner decision, 2026-08-19: the royalty STAYS on gross, and the product says
// so. No arithmetic changes here — this is a test about words, and the words
// are the whole of the decision.
//
// ── WHAT THE PERCENTAGE MULTIPLIES ────────────────────────────────────────
//
//     royalty = round(revenue_cents * royalty_percent / 100)
//     revenue_cents = sum(payments.amount_cents) for the period
//
// `payments.amount_cents` excludes the card surcharge — correct, and settled
// long ago: the surcharge was fee recovery and was never revenue. It does NOT
// exclude Stripe's processing fee, and it does not exclude HoundStack's own
// 50 bps `application_fee_amount`. Both come out of the location's side of the
// charge. So a location billed 7% of "collected revenue" pays 7% of a number
// larger than the one that reached its bank, by two deductions the statement
// never mentioned.
//
// That is a legitimate way to write a franchise agreement and it is not this
// product's place to change it. It IS this product's place to say it, in the
// two places where somebody is about to be surprised: the editor where the
// percentage is chosen, and the statement where it is billed.
//
// ── WHY THE EXISTING PHRASE IS KEPT ───────────────────────────────────────
//
// "% of collected revenue" stays verbatim. /franchise already names
// franchise_rollup's gross "Collected MTD" and reserves "Revenue" for the net,
// and the statement's own line was relabelled "Collected revenue" on
// 2026-08-19 for exactly that reason. A fourth wording for one figure is how
// the previous round of this went wrong, so the new sentence sits BESIDE the
// phrase rather than replacing it.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_FEE_BPS } from "../src/lib/platform-fee";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(ROOT + p, "utf8");

const route = read("src/routes/_authenticated/franchise.tsx");
const component = read("src/components/FranchiseSettlementStatements.tsx");

/** The rendered text of a TSX file: comments removed, JSX entities restored,
 *  whitespace flattened. Every claim below is about what a person READS, and
 *  `HoundStack&apos;s` is not a phrase anybody reads. */
function rendered(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join(" ")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ");
}

const routeText = rendered(route);
const componentText = rendered(component);

describe("the stripper leaves the copy and removes the reasoning", () => {
  it("drops a JSX comment that argues for the copy beside it", () => {
    expect(rendered("{/* before fees */}\n<p>after fees</p>")).not.toContain("before fees");
    expect(rendered("{/* x */}\n<p>after fees</p>")).toContain("after fees");
  });
});

describe("the rate editor says what the percentage is a percentage of", () => {
  it("keeps the phrase the rest of the product uses", () => {
    // Pinned by tests/a-statement-you-could-not-check-the-arithmetic-of too.
    // One vocabulary, or the two screens cannot be reconciled.
    expect(routeText).toContain("% of collected revenue");
  });

  it("says the percentage applies before fees", () => {
    expect(routeText).toMatch(/percentage applies to collected revenue before fees/i);
  });

  it("names both deductions, rather than gesturing at 'fees'", () => {
    // "Fees" is what the reader already assumed was excluded. The two that are
    // not have names, and one of them is ours.
    expect(routeText).toMatch(/Stripe's processing fee/i);
    expect(routeText).toMatch(/HoundStack's 0\.5% platform fee/i);
  });

  it("quotes the platform fee the code actually charges", () => {
    // 50 bps. If PLATFORM_FEE_BPS ever moves, this copy is a claim about money
    // that has gone stale on the screen where an owner sets a rate.
    expect(PLATFORM_FEE_BPS).toBe(50);
    expect(routeText).toContain(`${PLATFORM_FEE_BPS / 100}% platform fee`);
  });

  it("still says the surcharge is out, so the reader is not told the base is everything", () => {
    expect(routeText).toMatch(/surcharge is already excluded/i);
  });
});

describe("the statement says it too, to whoever is reading it", () => {
  it("says the percentage applies before fees", () => {
    expect(componentText).toMatch(/percentage applies to collected revenue before fees/i);
  });

  it("names both deductions", () => {
    expect(componentText).toMatch(/Stripe's processing fee/i);
    expect(componentText).toMatch(/HoundStack's 0\.5% platform fee/i);
  });

  it("says it to BOTH parties", () => {
    // The two sides reconcile the same document. A disclosure only the
    // franchise can see is the fault this component was built to prevent —
    // "if each side read a differently-worded version the first disagreement
    // would be about the software rather than about the money".
    const block = componentText.slice(
      componentText.indexOf("The percentage applies to collected revenue before fees"),
    );
    expect(block.slice(0, 400)).toMatch(/forLocation \? "you receive" : "the location receives"/);
  });

  it("still calls the gross line 'Collected revenue', not 'Revenue'", () => {
    // Six inches up the same page, "Revenue" means the figure NET of refunds.
    expect(component).toMatch(/Collected revenue \{settlementMoney\(line\.revenueCents\)\}/);
  });
});

describe("nothing about the arithmetic moved", () => {
  const MIGRATIONS = join(ROOT, "supabase", "migrations");
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let body = "";
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    const m =
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.generate_franchise_settlements\s*\(/i.exec(
        sql,
      );
    if (m) body = sql.slice(m.index, sql.indexOf("$function$;", m.index));
  }

  it("still takes the royalty on the period's collected total", () => {
    expect(body).toMatch(/round\(r\.total \* r\.pct \/ 100\.0\)/);
  });

  it("still builds that total out of payments.amount_cents", () => {
    // Which is base only — the surcharge never entered it — and gross of both
    // fees, which is the fact the copy above now discloses.
    expect(body).toMatch(/coalesce\(sum\(p\.amount_cents\), 0\)::bigint AS total/);
  });

  it("deducts no fee from the royalty base", () => {
    // The change the owner declined. If this ever appears, the copy above is
    // wrong and a franchisee is being told the opposite of what they are billed.
    expect(body).not.toMatch(/application_fee|processing_fee|stripe_fee/i);
  });
});
