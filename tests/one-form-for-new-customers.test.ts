// One public form per business, 2026-10-08.
//
// The owner: "there's a lead capture form and an online signup form, there's a
// ton of overlap here; it should essentially be slimmed down to one to avoid
// confusion." /signup/{slug} is that one form now: it prices the yard where it
// can, and the visitor either starts service with a card or asks for a quote.
// /lead/{slug} forwards to it. See src/lib/new-customer-form.ts.
//
// What this pins:
//   1. which way the form can go: priced zone, no zone, instant start off
//   2. the quote request is the lead form's own request, unchanged
//   3. consent: the booking link asks (unticked, optional, the business's own
//      words, #538); the quote request still stores none; same footer
//   4. the retired address forwards with its query string, byte for byte
//   5. a signup lands in Leads too, and the webhook marks it converted
//   6. one settings page, and the old one forwards to it

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FORM_DEFAULTS,
  LEAD_SOURCE,
  QUOTE_REQUEST_DISCLOSURE,
  askedFields,
  decideFormBranch,
  formCopy,
  leadBodyFromForm,
  leadOriginLabel,
  normalizeFormConfig,
  retiredLeadFormHref,
} from "@/lib/new-customer-form";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Negative assertions run on code with comment lines stripped, so the prose
 *  explaining what was removed cannot fail them. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(
        t.startsWith("//") ||
        t.startsWith("*") ||
        t.startsWith("/*") ||
        t.startsWith("--") ||
        t.startsWith("{/*")
      );
    })
    .join("\n");

const QUOTE = { zone_name: "North", recurring_price_cents: 2500 };

describe("which way the form can go", () => {
  it("a priced zone offers both: start service, or just send a quote", () => {
    const b = decideFormBranch({ instantStart: true, answer: { available: true, quote: QUOTE } });
    expect(b).toEqual({
      canStartService: true,
      canRequestQuote: true,
      quote: QUOTE,
      reason: "priced",
    });
  });

  it("a ZIP outside every zone is a quote request, not a dead end", () => {
    const b = decideFormBranch({ instantStart: true, answer: { available: false } });
    expect(b).toEqual({
      canStartService: false,
      canRequestQuote: true,
      quote: null,
      reason: "no-zone",
    });
  });

  it("instant start switched off is a quote request, even where a price exists", () => {
    // The page never asks for a price when the switch is off (public_quote
    // refuses anyway), but even handed one, the decision does not offer a card.
    const b = decideFormBranch({ instantStart: false, answer: { available: true, quote: QUOTE } });
    expect(b).toEqual({
      canStartService: false,
      canRequestQuote: true,
      quote: null,
      reason: "instant-off",
    });
  });

  it("before the visitor has asked for a price, a quote request is still there", () => {
    const b = decideFormBranch({ instantStart: true, answer: null });
    expect(b).toEqual({
      canStartService: false,
      canRequestQuote: true,
      quote: null,
      reason: "not-priced-yet",
    });
  });

  it("walk mode turns the quote request off and keeps everything else", () => {
    const b = decideFormBranch({
      instantStart: true,
      answer: { available: true, quote: QUOTE },
      offerQuoteRequest: false,
    });
    expect(b.canStartService).toBe(true);
    expect(b.canRequestQuote).toBe(false);
  });

  it("with a price on offer the ZIP and the dogs are always asked; without, the owner's toggles stand", () => {
    const off = { phone: false, location: false, dogCount: false, message: false };
    expect(askedFields(off, true)).toEqual({
      phone: false,
      location: true,
      dogCount: true,
      message: false,
    });
    expect(askedFields(off, false)).toEqual(off);
  });
});

describe("the quote request is the lead form's request", () => {
  it("posts to the endpoint the lead form always used, with its source", () => {
    const flow = read("src/components/signup/SignupFlow.tsx");
    expect(flow).toMatch(/fetch\("\/api\/public\/leads"/);
    expect(flow).toMatch(/leadBodyFromForm\(slug, form\)/);
    expect(LEAD_SOURCE.quoteRequest).toBe("website");
  });

  it("assembles the address the old form took as one free-text box", () => {
    const body = leadBodyFromForm("acme", {
      name: " Jane Doe ",
      email: "jane@example.com",
      phone: "",
      street: "612 Maple St",
      city: "Southfield",
      region: "MI",
      postal_code: "48037",
      dog_count: "2",
      frequency: "weekly",
      message: "Gate code 1234",
    });
    expect(body).toEqual({
      slug: "acme",
      name: "Jane Doe",
      email: "jane@example.com",
      phone: "",
      location: "612 Maple St, Southfield, MI 48037",
      dog_count: 2,
      frequency: "weekly",
      message: "Gate code 1234",
      source: "website",
    });
  });

  it("a ZIP alone is a location, as half the old form's leads were", () => {
    const body = leadBodyFromForm("acme", {
      name: "J",
      email: "j@example.com",
      phone: "",
      street: "",
      city: "",
      region: "",
      postal_code: "78701",
      dog_count: "",
      frequency: "weekly",
      message: "",
    });
    expect(body.location).toBe("78701");
    expect(body.dog_count).toBeUndefined();
  });

  it("the endpoint's schema accepts every key the form sends", () => {
    const api = read("src/routes/api/public/leads.ts");
    for (const k of [
      "slug",
      "name",
      "email",
      "phone",
      "location",
      "dog_count",
      "frequency",
      "message",
      "source",
    ]) {
      expect(api, k).toMatch(new RegExp(`\\b${k}: z\\.`));
    }
  });
});

describe("consent: the booking link asks, and never requires", () => {
  // Until #538 neither public form showed an SMS consent checkbox. A
  // business's client is texted only from that business's own number, under
  // its own registration, and only with recorded consent, so the booking link
  // now asks: unticked, optional, in words that name the business and link
  // its own Terms and Privacy, and only on the start-service branch, which is
  // the one that makes a client for the consent to belong to. The quote
  // request still records nothing, because no client exists to hold it.

  const flow = codeOnly(read("src/components/signup/SignupFlow.tsx"));
  const page = codeOnly(read("src/routes/signup.$slug.tsx"));

  it("the disclosure under the quote request is the lead form's, word for word", () => {
    expect(QUOTE_REQUEST_DISCLOSURE).toBe("We'll only use this to follow up about your quote.");
    expect(flow).toMatch(/\{QUOTE_REQUEST_DISCLOSURE\}/);
  });

  it("the box is unticked until the visitor ticks it, and shows the server's wording", () => {
    expect(flow).toMatch(/useState\(false\)/);
    expect(flow).toMatch(/const \[smsOptIn, setSmsOptIn\] = useState\(false\)/);
    expect(flow).toMatch(/ClientSmsConsentWordingText wording=\{formQ\.data\.smsConsent\}/);
    // HoundStack's account-holder wording is not the client's.
    for (const src of [flow, page]) expect(src).not.toMatch(/SMS_CONSENT_TEXT/);
  });

  it("booking never depends on it", () => {
    const fns = codeOnly(read("src/lib/signup.functions.ts"));
    expect(fns).toMatch(/sms_opt_in: z\.boolean\(\)\.optional\(\)/);
    // The stored words are the server's, built from the business's own name.
    expect(fns).toMatch(/orgClientSmsConsentWording/);
  });

  it("the quote request still writes no consent field", () => {
    const api = codeOnly(read("src/routes/api/public/leads.ts"));
    const insert = api.slice(
      api.indexOf('.from("leads")'),
      api.indexOf("if (error)", api.indexOf('.from("leads")')),
    );
    expect(insert).not.toMatch(/consent/i);
  });

  it("the paid signup records it as 'booking', only for the number it was given for", () => {
    const hook = codeOnly(read("src/routes/api/public/hooks/stripe.ts"));
    const provision = hook.slice(0, hook.indexOf("Best-effort welcome email"));
    expect(provision).toMatch(/record_client_sms_consent/);
    expect(provision).toMatch(/_source: "booking"/);
    expect(provision).toMatch(/digits\(onFile\.primary_phone\) === digits\(sr\.sms_consent_phone\)/);
  });

  it("the footer that links Privacy, Terms and SMS Consent wraps every state of the page, framed or not", () => {
    const shell = read("src/components/marketing/TenantSignupShell.tsx");
    expect(shell).toMatch(/to="\/legal\/sms"/);
    // compact (inside an iframe) hides the header only
    const footer = shell.slice(shell.indexOf("<footer"));
    expect(footer).not.toMatch(/compact \?\s*null/);
    expect((page.match(/<TenantSignupShell/g) ?? []).length).toBe(3);
  });

  it("the account holder's consent string is untouched", () => {
    // Quoted verbatim in the toll-free filing; changing a word is a 30507.
    expect(read("src/routes/get-started.tsx")).toMatch(/SMS_CONSENT_TEXT/);
  });
});

describe("the retired address forwards, query string and all", () => {
  it("keeps every parameter, in order, exactly as it arrived", () => {
    const qs =
      "?zone=north&ref=door-42&utm_source=flyer&utm_campaign=spring%20promo&embed=1&walk=1";
    expect(retiredLeadFormHref("acme-yard", qs)).toBe(`/signup/acme-yard${qs}`);
  });

  it("no query string, or an empty one, adds nothing", () => {
    expect(retiredLeadFormHref("acme", "")).toBe("/signup/acme");
    expect(retiredLeadFormHref("acme", "?")).toBe("/signup/acme");
  });

  it("a slug cannot break out of its path segment", () => {
    expect(retiredLeadFormHref("a/b?x", "")).toBe("/signup/a%2Fb%3Fx");
  });

  it("the route redirects on the server, temporarily, and renders nothing", () => {
    const route = read("src/routes/lead.$slug.tsx");
    const code = codeOnly(route);
    expect(code).toMatch(/beforeLoad: async \(\{ params, location \}\)/);
    // The raw query string from the request, not the router's re-serialised
    // copy, which turns a ref code of 12e3 into 12000.
    expect(code).toMatch(/new URL\(getRequest\(\)\.url\)\.search/);
    expect(code).toMatch(/retiredLeadFormHref\(params\.slug, raw \?\? location\.searchStr\)/);
    expect(code).toMatch(/statusCode: 302/);
    expect(code).not.toMatch(/ssr: false/);
    // If it is ever rendered rather than redirected, it says where it is
    // going and goes there, query string and all (RedirectFallback keeps
    // the search params).
    expect(code).toMatch(/<RedirectFallback to=\{`\/signup\/\$\{encodeURIComponent\(slug\)\}`\}/);
  });

  it("and the page it lands on passes every parameter through", () => {
    expect(read("src/routes/signup.$slug.tsx")).toMatch(
      /validateSearch: \(s: Record<string, unknown>\) => s,/,
    );
  });
});

describe("one page always loads, and the switch decides only the card", () => {
  const fns = read("src/lib/signup.functions.ts");
  const lookup = fns.slice(
    fns.indexOf("export const getPublicSignupForm"),
    fns.indexOf("const quoteSchema"),
  );

  it("resolves through the lead form's lookup, which does not look at the switch", () => {
    expect(lookup).toMatch(/public_get_org_for_lead_form/);
    expect(codeOnly(lookup)).not.toMatch(/public_get_org_by_slug/);
  });

  it("offers Start service only when the switch is on AND a card can be taken", () => {
    expect(lookup).toMatch(/const enabled = !!org\?\.public_signup_enabled/);
    expect(lookup).toMatch(/resolveOrgStripeAccount/);
    expect(lookup).toMatch(/!acct \|\| !acct\.chargesEnabled\) instantStart = false/);
    expect(lookup).toMatch(/org_can_add_client/);
  });

  it("prices only through public_quote, unchanged", () => {
    // The page does not fork pricing: the quote and the charge both come from
    // the same RPC they always did, which is still gated on the switch.
    expect(fns.match(/sb\.rpc\("public_quote"/g)?.length).toBe(2);
    expect(read("src/components/signup/SignupFlow.tsx")).toMatch(/getSignupQuote/);
  });

  it("the old two lookups are gone, not left beside the new one", () => {
    expect(codeOnly(fns)).not.toMatch(/export const getSignupOrg\b/);
    expect(codeOnly(read("src/lib/leads.functions.ts"))).not.toMatch(
      /export const getPublicLeadForm\b/,
    );
  });

  it("the owner's words win, and the defaults follow the mode", () => {
    const blank = normalizeFormConfig(null);
    expect(formCopy(blank, true).headline).toBe(FORM_DEFAULTS.instant.headline);
    expect(formCopy(blank, false).headline).toBe(FORM_DEFAULTS.quoteOnly.headline);
    const own = normalizeFormConfig({ headline: "  Free yard quote  ", fields: { phone: false } });
    expect(formCopy(own, true).headline).toBe("Free yard quote");
    expect(own.fields).toEqual({ phone: false, location: true, dogCount: true, message: true });
  });
});

describe("every signup lands in Leads too", () => {
  const fns = read("src/lib/signup.functions.ts");
  const checkout = fns.slice(fns.indexOf("export const createSignupPaymentIntent"));

  it("the signup writes its lead after the entitlement gate and links it", () => {
    const gate = checkout.indexOf('rpc("org_can_add_client"');
    const lead = checkout.indexOf("await recordSignupLead(");
    const insert = checkout.indexOf('.from("signup_requests")\n      .insert(');
    expect(gate).toBeGreaterThan(0);
    expect(lead).toBeGreaterThan(gate);
    expect(insert).toBeGreaterThan(lead);
    expect(checkout.slice(insert, insert + 200)).toMatch(/lead_id: leadId/);
  });

  it("one household is one lead however many times they press Start service", () => {
    const helper = fns.slice(fns.indexOf("async function recordSignupLead"));
    expect(helper).toMatch(/\.eq\("email", email\)/);
    expect(helper).toMatch(/\.eq\("status", "new"\)/);
    expect(helper).toMatch(/\.gte\("created_at", since\)/);
  });

  it("a lead that fails to write does not stop the sale", () => {
    const helper = fns.slice(fns.indexOf("async function recordSignupLead"));
    expect(helper).toMatch(/console\.error\("signup lead write failed"/);
    expect(helper).toMatch(/return null;/);
  });

  it("the webhook marks it converted, through the wizard's own helper", () => {
    const hook = read("src/routes/api/public/hooks/stripe.ts");
    expect(hook).toMatch(/markLeadConverted\(supabaseAdmin, sr\.lead_id as string, client\.id\)/);
    expect(hook).toMatch(/console\.error\("signup lead conversion failed"/);
  });

  it("the migration that links them replays into an empty database", () => {
    const sql = read("supabase/migrations/20261008160000_a-signup-is-a-lead-too.sql");
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES public\.leads\(id\) ON DELETE SET NULL/,
    );
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS signup_requests_lead_id_idx/);
    expect(codeOnly(sql)).not.toMatch(/ENABLE ROW LEVEL SECURITY/);
  });

  it("Leads says which is which", () => {
    expect(leadOriginLabel("website", null)).toBe("Quote request");
    expect(leadOriginLabel("online_signup", { status: "provisioned", refunded_at: null })).toBe(
      "Started service online",
    );
    expect(leadOriginLabel("online_signup", { status: "pending", refunded_at: null })).toBe(
      "Started signup online, didn't pay",
    );
    expect(leadOriginLabel("online_signup", null)).toBe("Started signup online, didn't pay");
    expect(leadOriginLabel("door_signup", { status: "provisioned", refunded_at: null })).toBe(
      "Started service at the door",
    );
    expect(leadOriginLabel("online_signup", { status: "failed", refunded_at: "2026-10-08" })).toBe(
      "Signed up online, refunded",
    );
    expect(leadOriginLabel("referral_partner", null)).toBe("Referral partner");

    const page = read("src/routes/_authenticated/leads.tsx");
    expect(page).toMatch(/leadOriginLabel\(l\.source, signup\)/);
    expect(read("src/lib/leads.functions.ts")).toMatch(
      /signup_requests\(status, refunded_at, created_at\)/,
    );
  });
});

describe("one settings page", () => {
  it("Lead form forwards to Signup & quote form", () => {
    const old = codeOnly(read("src/routes/_authenticated/settings.lead-form.tsx"));
    expect(old).not.toMatch(/beforeLoad\s*:/);
    expect(old).toMatch(/<RedirectFallback to="\/settings\/online-signup"/);
  });

  it("the merged page keeps every option either page had", () => {
    const page = read("src/routes/_authenticated/settings.online-signup.tsx");
    // Online signup's: the switch and the address
    expect(page).toMatch(/publicSignupEnabled: v/);
    expect(page).toMatch(/signupSlug: slug\.trim\(\)/);
    // Lead form's: link, embed, branding, copy, questions, counts
    expect(page).toMatch(/Embed on your website/);
    for (const k of ["brandColor", "logoUrl", "headline", "intro", "confirmation", "fields"]) {
      expect(page, k).toMatch(new RegExp(`\\b${k}\\b`));
    }
    expect(page).toMatch(/submissionsTotal/);
    expect(page).toMatch(/submissionsLast30/);
  });

  it("and the nav lists it once", () => {
    const nav = read("src/routes/_authenticated/settings.tsx");
    expect(codeOnly(nav)).not.toMatch(/to: "\/settings\/lead-form"/);
    expect(nav.match(/to: "\/settings\/online-signup"/g)?.length).toBe(1);
  });

  it("Leads previews the one form and edits it in one place", () => {
    const page = read("src/routes/_authenticated/leads.tsx");
    expect(page).toMatch(/href=\{`\/signup\/\$\{formSlug\}`\}/);
    expect(page).toMatch(/<Link to="\/settings\/online-signup">/);
    expect(codeOnly(page)).not.toMatch(/\/lead\/\$\{/);
  });
});
