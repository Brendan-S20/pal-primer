// Booking link batch 2: who the business is, where it works, what its link
// previews as, and where a phone shows the price (#523, #524, #526).
//
// The words and the head are pure (lib/booking-page.ts) and pinned here
// exactly. The layout claims (the answer under step 1 below `lg`, the bar,
// the 404) are pinned in the source here and measured for real elsewhere:
// tests/viewports/the-half-of-the-product-the-customer-uses.spec.ts at 390,
// 768 and 1440, and tests/e2e/a-booking-link-names-the-business.spec.ts for
// the server's HTML with no browser.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NEUTRAL_PREVIEW_IMAGE,
  bookingPageDescription,
  bookingPageHead,
  outOfAreaAnswer,
  serviceAreaSummary,
  telHref,
  unavailablePageHead,
} from "@/lib/booking-page";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the service area line (#526)", () => {
  it("lists a few ZIPs by number and counts the rest", () => {
    expect(serviceAreaSummary([{ zip_codes: ["78704"] }])).toBe("Serving ZIP code 78704");
    expect(serviceAreaSummary([{ zip_codes: ["78704", "78701"] }, { zip_codes: ["78702"] }])).toBe(
      "Serving ZIP codes 78701, 78702 and 78704",
    );
    expect(
      serviceAreaSummary([{ zip_codes: ["60618", "60625", "60640", "60641", "60645", "60659"] }]),
    ).toBe("Serving ZIP codes 60618, 60625, 60640 and 3 more");
  });

  it("counts a ZIP two zones share once, and reads a prefix", () => {
    expect(serviceAreaSummary([{ zip_codes: ["78704"] }, { zip_codes: [" 78704 "] }])).toBe(
      "Serving ZIP code 78704",
    );
    expect(serviceAreaSummary([{ postal_prefix: "787" }])).toBe("Serving ZIP codes starting 787");
    expect(serviceAreaSummary([{ postal_prefix: "787", zip_codes: ["78610"] }])).toBe(
      "Serving ZIP codes starting 787, plus 78610",
    );
  });

  it("is hidden when no zone lists a ZIP, rather than serving nothing", () => {
    expect(serviceAreaSummary([])).toBeNull();
    expect(serviceAreaSummary([{ zip_codes: [], postal_prefix: null }])).toBeNull();
  });

  it("is built from ZIPs alone: the lookup never reads a zone's name or price", () => {
    const fns = read("src/lib/signup.functions.ts");
    const lookup = fns.slice(
      fns.indexOf("export const getPublicSignupForm"),
      fns.indexOf("const quoteSchema"),
    );
    // `enabled` (#449) so a zone that is turned off is left out; still no
    // name and no price.
    expect(lookup).toMatch(/\.from\("zones"\)\s*\.select\("zip_codes, postal_prefix, enabled"\)/);
  });
});

describe("an out-of-area ZIP gets an honest answer (#526)", () => {
  it("says the business may not work there, and keeps the request open", () => {
    expect(outOfAreaAnswer("Riverbend Pet Services", "90210")).toBe(
      "Riverbend Pet Services doesn't list 90210 in its service area yet. Leave your details and they'll let you know if they can help.",
    );
    expect(outOfAreaAnswer(null, "")).toMatch(/^This business doesn't list that ZIP/);
  });

  it("is what the form says, in place of the old line", () => {
    const flow = read("src/components/signup/SignupFlow.tsx");
    expect(flow).toMatch(/outOfAreaAnswer\(formQ\.data\.name, quotedZip\)/);
    expect(flow).not.toContain("We don't have online pricing for that ZIP yet");
    expect(read("src/lib/booking-copy.ts")).not.toMatch(/outOfArea/);
  });
});

describe("the quote panel does not show the office's zone name (#526)", () => {
  it("renders no zone_name", () => {
    expect(read("src/components/signup/SignupFlow.tsx")).not.toMatch(/quote\.zone_name/);
  });
});

describe("contact details under the headline (#526)", () => {
  it("dials digits only, and hides a number with nothing to dial", () => {
    expect(telHref("(773) 555-0142")).toBe("tel:7735550142");
    expect(telHref("+1 773.555.0142 ext")).toBe("tel:+17735550142");
    expect(telHref("")).toBeNull();
    expect(telHref(null)).toBeNull();
    expect(telHref("call us")).toBeNull();
  });

  it("comes from the one lookup, and each item hides when unset", () => {
    const fns = read("src/lib/signup.functions.ts");
    expect(fns).toMatch(/first_cleanup_pricing, contact_phone, contact_email(, service_lines)?"/);
    const route = read("src/routes/signup.$slug.tsx");
    expect(route).toMatch(
      /<BusinessFacts contact=\{org\.contact\} serviceArea=\{org\.serviceArea\} \/>/,
    );
    expect(route).toMatch(/if \(!tel && !contact\.email && !serviceArea\) return null;/);
  });

  it("is listed in Settings with where to edit it", () => {
    const page = read("src/routes/_authenticated/settings.online-signup.tsx");
    expect(page).toContain("What the page says about you");
    expect(page).toMatch(/to="\/settings\/client-portal"/);
    expect(page).toMatch(/to="\/zones"/);
  });
});

describe("the link preview names the business (#524)", () => {
  const base = {
    title: "Riverbend Pet Services · Get a quote",
    name: "Riverbend Pet Services",
    logoUrl: null,
    slug: "demo-pet-waste-co",
    lines: ["pet_waste"] as const,
    origin: "https://app.houndstack.com",
  };
  const tag = (h: ReturnType<typeof bookingPageHead>, key: string) =>
    h.meta.find((m) => m.name === key || m.property === key)?.content;

  it("titles and describes the page as the business", () => {
    const h = bookingPageHead(base);
    expect(h.meta.find((m) => m.title)?.title).toBe("Riverbend Pet Services · Get a quote");
    expect(tag(h, "og:title")).toBe("Riverbend Pet Services · Get a quote");
    expect(tag(h, "twitter:title")).toBe("Riverbend Pet Services · Get a quote");
    expect(tag(h, "og:site_name")).toBe("Riverbend Pet Services");
    expect(tag(h, "description")).toBe(
      "Riverbend Pet Services offers pet waste removal. Enter your ZIP, number of dogs, and cleanup frequency to get a price, then start service online or ask for a quote.",
    );
    expect(tag(h, "og:description")).toBe(tag(h, "description"));
  });

  it("points og:url and canonical at the page's own address", () => {
    const h = bookingPageHead(base);
    expect(tag(h, "og:url")).toBe("https://app.houndstack.com/signup/demo-pet-waste-co");
    expect(h.links).toEqual([
      { rel: "canonical", href: "https://app.houndstack.com/signup/demo-pet-waste-co" },
    ]);
  });

  it("previews the logo when set, else a neutral image that is not ours", () => {
    const neutral = bookingPageHead(base);
    expect(tag(neutral, "og:image")).toBe(`https://app.houndstack.com${NEUTRAL_PREVIEW_IMAGE}`);
    expect(tag(neutral, "twitter:card")).toBe("summary_large_image");
    expect(tag(neutral, "og:image:width")).toBe("1200");

    const withLogo = bookingPageHead({ ...base, logoUrl: "https://cdn.example.com/rb.png" });
    expect(tag(withLogo, "og:image")).toBe("https://cdn.example.com/rb.png");
    expect(tag(withLogo, "twitter:image")).toBe("https://cdn.example.com/rb.png");
    expect(tag(withLogo, "twitter:card")).toBe("summary");
    // The root's 1200x630 would be untrue of a logo, so it is emptied.
    expect(tag(withLogo, "og:image:width")).toBeUndefined();
  });

  it("overrides every tag the root sets about HoundStack, and nothing says HoundStack", () => {
    const h = bookingPageHead(base);
    for (const key of [
      "description",
      "og:site_name",
      "og:title",
      "og:description",
      "og:url",
      "og:image",
      "og:image:width",
      "og:image:height",
      "twitter:title",
      "twitter:description",
      "twitter:image",
      "twitter:card",
    ]) {
      expect(
        h.meta.some((m) => m.name === key || m.property === key),
        key,
      ).toBe(true);
    }
    const words = h.meta
      .filter(
        (m) => m.property !== "og:url" && m.property !== "og:image" && m.name !== "twitter:image",
      )
      .map((m) => m.title ?? m.content ?? "")
      .join(" ");
    expect(words).not.toMatch(/houndstack/i);
  });

  it("is neutral when the business is not known, and unbranded on a 404", () => {
    const unknown = bookingPageHead({ ...base, title: "Get a quote", name: null });
    expect(unknown.meta.find((m) => m.title)?.title).toBe("Get a quote");
    expect(tag(unknown, "og:site_name")).toBeUndefined();
    const gone = unavailablePageHead(base.origin);
    expect(gone.meta.find((m) => m.title)?.title).toBe("This page isn't available");
    expect(tag(gone, "og:image")).toBe(`https://app.houndstack.com${NEUTRAL_PREVIEW_IMAGE}`);
    for (const h of [unknown, gone]) {
      const words = h.meta
        .filter(
          (m) => m.property !== "og:url" && m.property !== "og:image" && m.name !== "twitter:image",
        )
        .map((m) => m.title ?? m.content ?? "")
        .join(" ");
      expect(words).not.toMatch(/houndstack/i);
    }
    const route = read("src/routes/signup.$slug.tsx");
    expect(route).toMatch(/if \(!loaderData\) return unavailablePageHead\(appOrigin\(\)\);/);
  });

  it("names several lines when the business sells several", () => {
    expect(bookingPageDescription("Riverbend", ["pet_waste", "dog_walking"])).toBe(
      "Riverbend. Get a price for pet waste removal or dog walking: pick a service and enter your ZIP and pets, then start service online or ask for a quote.",
    );
  });

  it("is looked up on the server, and a slug that names nobody is a 404", () => {
    const route = read("src/routes/signup.$slug.tsx");
    expect(route).toMatch(/title: customerTitle\(org\?\.name, "Get a quote"\)/);
    expect(route).toMatch(
      /form = await getPublicSignupForm\(\{ data: \{ slug: params\.slug \} \}\)/,
    );
    expect(route).toMatch(/if \(!form\) throw notFound\(\);/);
    expect(route).toMatch(/notFoundComponent: SignupPageUnavailable/);
    // The page's query starts from the loader's answer, so the server's HTML
    // is the form and hydration has nothing to disagree with.
    expect(route).toMatch(/initialData: loaded \?\? undefined/);
    // A failed lookup is not a 404: the browser asks again.
    expect(route).toMatch(/catch \{\s*return \{ form: null as SignupForm \| null \};\s*\}/);
    const fns = read("src/lib/signup.functions.ts");
    expect(fns).toMatch(/if \(!found\) return null;/);
  });
});

describe("on a phone the price shows where the visitor tapped (#523)", () => {
  const flow = read("src/components/signup/SignupFlow.tsx");

  it("answers under step 1 below lg, and only there", () => {
    expect(flow).toMatch(/const narrowOnly = variant === "page" \? "lg:hidden" : "";/);
    expect(flow).toMatch(/ref=\{answerRef\}[\s\S]{0,120}aria-live="polite"/);
    // Inside the service card, right after the button.
    const card = flow.slice(flow.indexOf("const serviceCard"), flow.indexOf("const detailsCard"));
    expect(card).toContain("{quoteAnswer}");
  });

  it("brings the answer into view and moves focus to it, except in two columns", () => {
    expect(flow).toMatch(/if \(!quoteMut\.data \|\| twoColumns\(\)\) return;/);
    expect(flow).toMatch(
      /el\.scrollIntoView\(\{ block: "nearest" \}\);\s*el\.focus\(\{ preventScroll: true \}\);/,
    );
  });

  it("keeps a compact summary in reach during step 2, never at lg", () => {
    const bar = flow.slice(
      flow.indexOf("const compactBar"),
      flow.indexOf('if (variant === "sheet")'),
    );
    expect(bar).toMatch(/quote && showBar/);
    expect(bar).toMatch(/fixed inset-x-0 bottom-0/);
    expect(bar).toContain("${narrowOnly}");
    expect(bar).toContain("Continue");
    expect(flow).toMatch(/const showBar = !answerInView && !panelInView;/);
    // The panel is reached when its prices are on the visible screen, the
    // keyboard excluded, not when it crosses a fixed fraction of it (#552).
    expect(flow).toMatch(/ref=\{panelPriceRef\}/);
    expect(flow).toContain("window.visualViewport");
    expect(flow).not.toContain('"0px 0px -40% 0px"');
    // Reached stays reached past the prices (one-sided), and a scrolling
    // sheet counts as much as a scrolling window (capture phase).
    expect(flow).toContain("setPanelInView(r.height > 0 && r.bottom <= bottom + 1);");
    expect(flow).toMatch(
      /addEventListener\("scroll", measure, \{ capture: true, passive: true \}\)/,
    );
  });

  it("is the same in walk mode's sheet, which is always narrow", () => {
    const sheet = flow.slice(flow.indexOf('if (variant === "sheet")'));
    expect(sheet).toMatch(/\{quotePanel\}\s*\{compactBar\}/);
  });
});
