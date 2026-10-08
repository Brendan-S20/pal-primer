// About forty pages were titled "HoundStack - Field Service App".
//
// That is the root route's default, and it is what every route without a
// `head()` of its own inherits. The rest used three formats between them:
// "Quotes · HoundStack", "My schedule - HoundStack", "Accounting sync ·
// Settings", and "Waste disposal log" with no brand at all. An owner with five
// tabs open could not tell them apart, and the installed app's window switcher
// showed one name for every window (launch pass, 2026-10, recommendation 2).
//
// The format is now one function, src/lib/page-title.ts: "Page · HoundStack",
// most specific part first, because a tab strip truncates from the right.
// This file holds every route to it:
//
//   * every route file declares a `head` title, unless it is listed below
//     with the reason it does not need one (a layout whose children title
//     themselves, a redirect that never paints);
//   * a staff or HoundStack page builds that title with pageTitle() or
//     titleHead(), never a literal, so the format cannot drift again one file
//     at a time;
//   * a customer-facing page uses customerTitle(), which never says
//     "HoundStack": the customer signed up with a pet-waste company, not with
//     us, and a tab named after a vendor they have never heard of is noise;
//   * the pages whose title depends on data (a client's name, an invoice
//     number) or on the device's language (the technician's screens) set it
//     with useDocumentTitle() once they know it.
//
// It reads source rather than rendering, so it names the file. The rendered
// half (that the browser tab really says it) is
// tests/viewports/every-tab-was-called-houndstack.spec.ts.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pageTitle, customerTitle, titleHead } from "../src/lib/page-title";

const root = join(import.meta.dirname, "..");
const routesDir = join(root, "src", "routes");

/** POSIX-style path relative to the repo, so the lists below mean the same
 *  thing on Windows, where `relative()` answers with backslashes. */
const rel = (abs: string) => relative(root, abs).split(sep).join("/");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "api" ? [] : walk(p);
    return name.endsWith(".tsx") ? [p] : [];
  });
}

/** The route's `head:` option, and nothing after it: a `{ title: "..." }`
 *  in a confirm dialog further down the file is not a tab title. */
function headBlock(src: string): string {
  const at = src.search(/\n {2}head:/);
  if (at < 0) return "";
  const rest = src.slice(at + 1);
  const oneLine = rest.slice(0, rest.indexOf("\n"));
  if (/\),?\s*$/.test(oneLine) && !/\(\{\s*$/.test(oneLine)) return oneLine;
  const end = rest.search(/\n {2}\}\),?\n/);
  return end < 0 ? oneLine : rest.slice(0, end);
}

const ROUTE_FILES = walk(routesDir).map((abs) => ({
  file: rel(abs),
  src: readFileSync(abs, "utf8"),
}));

/** Routes that need no title of their own, each with the reason. */
const NO_TITLE_NEEDED: Record<string, string> = {
  "src/routes/__root.tsx": "the default every other route overrides",
  "src/routes/_authenticated/route.tsx": "the signed-in shell; every page inside it titles itself",
  "src/routes/_authenticated/campaigns.tsx": "an <Outlet /> layout",
  "src/routes/_authenticated/clients.tsx": "an <Outlet /> layout",
  "src/routes/_authenticated/invoices.tsx": "an <Outlet /> layout",
  "src/routes/_authenticated/quotes.tsx": "an <Outlet /> layout",
  "src/routes/_authenticated/messages.index.tsx":
    "the empty pane inside Messages, which titles itself",
  "src/routes/_authenticated/billing.tsx": "redirects to /settings/billing before painting",
  "src/routes/_authenticated/ai-tools.tsx": "redirects to /dashboard before painting",
  "src/routes/_authenticated/settings.index.tsx": "redirects to /settings/preferences",
  "src/routes/_authenticated/settings.payments.tsx": "redirects to /payments",
  "src/routes/index.tsx": "redirects to /auth",
  "src/routes/platform.index.tsx": "redirects to /platform/overview",
  "src/routes/portal.$slug.tsx": "resolves the business and redirects",
  "src/routes/portal.$slug.index.tsx": "the generic entry, which redirects into a portal",
  // The portal's six tabs share the layout's title, which names the business.
  "src/routes/portal.$slug.$token.index.tsx": "a portal tab; the portal layout titles it",
  "src/routes/portal.$slug.$token.visits.tsx": "a portal tab; the portal layout titles it",
  "src/routes/portal.$slug.$token.billing.tsx": "a portal tab; the portal layout titles it",
  "src/routes/portal.$slug.$token.property.tsx": "a portal tab; the portal layout titles it",
  "src/routes/portal.$slug.$token.requests.tsx": "a portal tab; the portal layout titles it",
  "src/routes/portal.$slug.$token.account.tsx": "a portal tab; the portal layout titles it",
};

/** Pages a CUSTOMER of a business reads, reached from a text or an email. */
const CUSTOMER_FACING = new Set([
  "src/routes/lead.$slug.tsx",
  "src/routes/pay.i.$token.tsx",
  "src/routes/q.$token.tsx",
  "src/routes/track.$token.tsx",
  "src/routes/signup.$slug.tsx",
  "src/routes/signup.success.tsx",
  "src/routes/unsubscribe.tsx",
  "src/routes/portal.$slug.$token.tsx",
  "src/routes/portal.$slug.$token.pay.$invoiceId.tsx",
]);

/** Pages whose title is only known once their data is: the static head says
 *  "Client", and the page replaces it with the client's name. */
const NAMED_BY_THEIR_DATA = [
  "src/routes/_authenticated/clients.$clientId.tsx",
  "src/routes/_authenticated/invoices.$invoiceId.tsx",
  "src/routes/_authenticated/quotes.$quoteId.tsx",
  "src/routes/_authenticated/messages.$clientId.tsx",
  "src/routes/_authenticated/campaigns.$campaignId.tsx",
  "src/routes/platform.tenants.$id.tsx",
];

/** The technician's screens, whose tab speaks the device's language. */
const IN_THE_DEVICES_LANGUAGE = [
  "src/routes/_authenticated/my-day.tsx",
  "src/routes/_authenticated/my-schedule.tsx",
  "src/routes/_authenticated/waste-log.tsx",
  "src/routes/_authenticated/notifications.tsx",
  "src/routes/_authenticated/settings.preferences.tsx",
];

describe("the title format", () => {
  it("is the page, then HoundStack, most specific first", () => {
    expect(pageTitle("Schedule")).toBe("Schedule · HoundStack");
    expect(pageTitle("Jane Doe", "Clients")).toBe("Jane Doe · Clients · HoundStack");
    expect(titleHead("Invoices")).toEqual({ meta: [{ title: "Invoices · HoundStack" }] });
  });

  it("drops a part that has not loaded rather than printing an empty slot", () => {
    expect(pageTitle(undefined, "Clients")).toBe("Clients · HoundStack");
    expect(pageTitle("", null, "Quotes")).toBe("Quotes · HoundStack");
  });

  it("never names HoundStack on a page a customer reads", () => {
    expect(customerTitle("Your quote", "Acme Scoopers")).toBe("Your quote · Acme Scoopers");
    expect(customerTitle("Your quote", null)).toBe("Your quote");
  });
});

describe("every route says what it is", () => {
  it("every exemption still names a file that exists", () => {
    const files = new Set(ROUTE_FILES.map((r) => r.file));
    for (const f of [...Object.keys(NO_TITLE_NEEDED), ...CUSTOMER_FACING, ...NAMED_BY_THEIR_DATA]) {
      expect(files.has(f), `${f} is listed here and no longer exists`).toBe(true);
    }
  });

  it("every route without an exemption declares a head title", () => {
    const missing = ROUTE_FILES.filter(
      (r) => !(r.file in NO_TITLE_NEEDED) && !/\n\s+head:\s*\(/.test(r.src),
    ).map((r) => r.file);
    expect(missing, "these routes inherit the root's plain 'HoundStack'").toEqual([]);
  });

  it("a staff or HoundStack page builds its title with pageTitle(), not a literal", () => {
    const wrong = ROUTE_FILES.filter(
      (r) =>
        !(r.file in NO_TITLE_NEEDED) &&
        !CUSTOMER_FACING.has(r.file) &&
        !/\b(titleHead|pageTitle)\(/.test(r.src),
    ).map((r) => r.file);
    expect(wrong).toEqual([]);
    const literal = ROUTE_FILES.filter(
      (r) => r.file !== "src/routes/__root.tsx" && /\{\s*title:\s*["'`]/.test(headBlock(r.src)),
    ).map((r) => r.file);
    expect(literal, "a title written as a literal is a fifth format waiting to happen").toEqual([]);
  });

  it("a customer-facing page never says HoundStack in its tab", () => {
    for (const f of CUSTOMER_FACING) {
      const src = ROUTE_FILES.find((r) => r.file === f)!.src;
      expect(src, f).toMatch(/\bcustomerTitle\(/);
      expect(src, f).not.toMatch(/\b(titleHead|pageTitle)\(/);
    }
  });

  it("a page named by its data sets the name once it has it", () => {
    for (const f of NAMED_BY_THEIR_DATA) {
      const src = ROUTE_FILES.find((r) => r.file === f)!.src;
      expect(src, f).toMatch(/\buseDocumentTitle\(/);
    }
  });

  it("a technician's tab is in the language their device reads", () => {
    for (const f of IN_THE_DEVICES_LANGUAGE) {
      const src = ROUTE_FILES.find((r) => r.file === f)!.src;
      expect(src, f).toMatch(/useDocumentTitle\(\s*pageTitle\(\s*t\(/);
    }
  });
});
