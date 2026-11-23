// #969: an owner without a website of their own can still register texting.
//
// Brendan, 2026-11-17: "host a Privacy and Terms page per business on
// mypets.services and use it by default". So:
//   - Settings > Texting starts on the hosted page; "I have my own website"
//     is the option, and that path keeps today's domain checks;
//   - on the hosted path the filing uses the listing URL plus its Privacy and
//     Terms URLs, all on one host, and the owner's normal email is accepted;
//   - the server files only the business's OWN published listing.
//
// TEST businesses only.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIRECTORY_BRAND } from "@/lib/directory-site";
import {
  HOSTED_SITE_HOST,
  hostedSiteBlocker,
  hostedSiteProblems,
  hostedSiteUrls,
  hostedSlugOf,
  ownSiteFields,
  siteChoiceFor,
  siteFields,
} from "@/lib/texting-hosted-site";
import { hostedSiteRefusal } from "@/lib/texting-hosted-site.server";
import { registrationDetailsSchema } from "@/lib/texting-registration";
import { HOSTED_POLICIES_LINE } from "@/lib/texting-hosted-site";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const SLUG = "qa-test-969";
const PUBLISHED = { slug: SLUG, published: true };

/** What the form holds before the owner touches the website fields. */
const BLANK_FORM = {
  legal_name: "QA TEST 969 Walks LLC",
  business_type: "llc" as const,
  dba: "QA TEST 969 Walks",
  street: "1 Test Street",
  street2: "",
  city: "Testville",
  region: "MI",
  postal_code: "48000",
  website_url: "",
  privacy_url: "",
  terms_url: "",
  business_email: "qa.test.969@gmail.com",
  business_phone: "(555) 555-0100",
  contacts: [
    {
      first_name: "Qa",
      last_name: "Test",
      title: "Owner",
      email: "qa.test.969@gmail.com",
      phone: "555-555-0101",
    },
    {
      first_name: "Qb",
      last_name: "Test",
      title: "Manager",
      email: "qb.test.969@gmail.com",
      phone: "555-555-0102",
    },
  ],
};

const OWN = {
  ...BLANK_FORM,
  website_url: "https://qa-test-969.example",
  privacy_url: "https://qa-test-969.example/privacy",
  terms_url: "https://qa-test-969.example/terms",
  business_email: "owner@qa-test-969.example",
};

function issues(d: unknown): Record<string, string> {
  const r = registrationDetailsSchema.safeParse(d);
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const i of r.error.issues) out[i.path.join(".")] ??= i.message;
  return out;
}

describe("the hosted page is the default", () => {
  it("is the directory's host, written once in lib/directory-site", () => {
    expect(HOSTED_SITE_HOST).toBe(DIRECTORY_BRAND);
    expect(hostedSiteUrls(SLUG)).toEqual({
      website_url: `https://${DIRECTORY_BRAND}/${SLUG}`,
      privacy_url: `https://${DIRECTORY_BRAND}/${SLUG}/privacy`,
      terms_url: `https://${DIRECTORY_BRAND}/${SLUG}/terms`,
    });
  });

  it("a new registration, or one saved on the hosted page, starts on the hosted page", () => {
    expect(siteChoiceFor(null)).toBe("hosted");
    expect(siteChoiceFor({ website_url: "" })).toBe("hosted");
    expect(siteChoiceFor({ website_url: hostedSiteUrls(SLUG).website_url })).toBe("hosted");
    // Only a saved website of the owner's own starts on "I have my own website".
    expect(siteChoiceFor({ website_url: OWN.website_url })).toBe("own");
    // ...and a saved hosted filing never shows up in the owner's own fields.
    expect(ownSiteFields(hostedSiteUrls(SLUG))).toEqual({
      website_url: "",
      privacy_url: "",
      terms_url: "",
    });
  });

  it("the filing uses the hosted URLs by default", async () => {
    const { tollFreeVerificationForm, businessInformationAttributes, detailsColumns } =
      await import("@/lib/twilio-provisioning.server");
    const filed = siteFields(BLANK_FORM, siteChoiceFor(null), PUBLISHED);
    const details = registrationDetailsSchema.parse(filed);
    const urls = hostedSiteUrls(SLUG);
    const form = tollFreeVerificationForm({
      details,
      ein: "12-3456789",
      phoneNumberSid: "PNtest",
      customerProfileSid: null,
      orgId: "org-test-969",
      businessName: "QA TEST 969 Walks",
      bookingUrl: null,
      notificationEmail: details.business_email,
    });
    expect(form.BusinessWebsite).toBe(urls.website_url);
    expect(form.PrivacyPolicyUrl).toBe(urls.privacy_url);
    expect(form.TermsAndConditionsUrl).toBe(urls.terms_url);
    expect(businessInformationAttributes(details, "12-3456789").website_url).toBe(urls.website_url);
    expect(detailsColumns(details)).toMatchObject(urls);
    // One host for all three.
    const hosts = new Set(
      [form.BusinessWebsite, form.PrivacyPolicyUrl, form.TermsAndConditionsUrl].map(
        (u) => new URL(u!).host,
      ),
    );
    expect([...hosts]).toEqual([DIRECTORY_BRAND]);
  });

  it("the hosted path accepts the owner's normal email", () => {
    for (const email of ["qa.test.969@gmail.com", "qa-test-969@yahoo.com", "qa@outlook.com"]) {
      expect(
        issues({ ...siteFields(BLANK_FORM, "hosted", PUBLISHED), business_email: email }),
      ).toEqual({});
    }
  });

  it("the hosted path still needs all three on the same host, at the listing's own paths", () => {
    const urls = hostedSiteUrls(SLUG);
    expect(hostedSiteProblems(urls)).toEqual([]);
    expect(
      issues({ ...BLANK_FORM, ...urls, privacy_url: "https://elsewhere.example/privacy" }),
    ).toHaveProperty("privacy_url");
    expect(
      issues({
        ...BLANK_FORM,
        ...urls,
        terms_url: `https://${DIRECTORY_BRAND}/someone-else/terms`,
      }),
    ).toHaveProperty("terms_url");
    expect(
      issues({ ...BLANK_FORM, ...urls, website_url: `http://${DIRECTORY_BRAND}/${SLUG}` }),
    ).toHaveProperty("website_url");
    expect(
      issues({ ...BLANK_FORM, ...urls, website_url: `https://${DIRECTORY_BRAND}/` }),
    ).toHaveProperty("website_url");
    expect(issues({ ...BLANK_FORM, ...urls, terms_url: urls.privacy_url })).toHaveProperty(
      "terms_url",
    );
    expect(hostedSlugOf(urls.website_url)).toBe(SLUG);
  });

  it("the hosted website is the bare page address: no login, no port", () => {
    const urls = hostedSiteUrls(SLUG);
    for (const website_url of [
      `https://user:pw@${DIRECTORY_BRAND}/${SLUG}`,
      `https://${DIRECTORY_BRAND}:8443/${SLUG}`,
    ]) {
      expect(hostedSiteProblems({ ...urls, website_url })).toHaveLength(1);
      expect(hostedSiteProblems({ ...urls, website_url })[0].path).toBe("website_url");
    }
  });

  it("with no listing yet, the hosted path says what to do instead of filing blanks", () => {
    expect(hostedSiteBlocker(PUBLISHED)).toBeNull();
    expect(hostedSiteBlocker({ slug: null, published: false })).toMatch(/Settings > Directory/);
    expect(hostedSiteBlocker({ slug: SLUG, published: false })).toMatch(/Publish your/);
    expect(hostedSiteBlocker(null)).toMatch(/I have my own website/);
    expect(siteFields(BLANK_FORM, "hosted", { slug: null, published: false }).website_url).toBe("");
  });
});

describe('"I have my own website" keeps today\'s domain checks', () => {
  it("a website with its pages and email on its own domain passes", () => {
    expect(issues(siteFields(OWN, "own", PUBLISHED))).toEqual({});
    // The own path files what the owner typed, not the hosted page.
    expect(siteFields(OWN, "own", PUBLISHED).website_url).toBe(OWN.website_url);
  });

  it("still requires https, Privacy and Terms on the website's domain, and an email on it", () => {
    expect(issues({ ...OWN, website_url: "http://qa-test-969.example" })).toHaveProperty(
      "website_url",
    );
    expect(issues({ ...OWN, privacy_url: "https://elsewhere.example/privacy" }).privacy_url).toBe(
      "This page has to be on your own website's domain",
    );
    expect(issues({ ...OWN, terms_url: "https://elsewhere.example/terms" }).terms_url).toBe(
      "This page has to be on your own website's domain",
    );
    expect(issues({ ...OWN, business_email: "qa.test.969@gmail.com" }).business_email).toBe(
      "Use an email address on your website's domain",
    );
  });

  it("an own website cannot borrow the hosted host for its policy pages", () => {
    const urls = hostedSiteUrls(SLUG);
    expect(issues({ ...OWN, privacy_url: urls.privacy_url })).toHaveProperty("privacy_url");
  });
});

describe("the server files only the business's own published page", () => {
  const urls = hostedSiteUrls(SLUG);
  const reader = (site: { slug: string | null; published: boolean }) => async () => site;

  it("accepts its own published listing", async () => {
    expect(await hostedSiteRefusal("org-test-969", urls, reader(PUBLISHED))).toBeNull();
  });

  it("refuses another business's page, an unpublished listing, and no listing", async () => {
    expect(
      await hostedSiteRefusal("org-test-969", hostedSiteUrls("qa-test-other"), reader(PUBLISHED)),
    ).toMatch(/different business/);
    expect(
      await hostedSiteRefusal("org-test-969", urls, reader({ slug: SLUG, published: false })),
    ).toMatch(/Publish/);
    expect(
      await hostedSiteRefusal("org-test-969", urls, reader({ slug: null, published: false })),
    ).toMatch(/Directory/);
  });

  it("does not read the listing at all for an owner's own website", async () => {
    let read = 0;
    const r = await hostedSiteRefusal("org-test-969", OWN, async () => {
      read++;
      return PUBLISHED;
    });
    expect(r).toBeNull();
    expect(read).toBe(0);
  });

  it("the submit asks it before anything goes to Twilio", () => {
    const fn = read("src/lib/texting-registration.functions.ts");
    const refusal = fn.indexOf("hostedSiteRefusal(orgId, data.details)");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(fn.indexOf('await import("@/lib/twilio-provisioning.server")'));
  });

  it("reads the listing's slug and published flag and nothing else", () => {
    const s = read("src/lib/texting-hosted-site.server.ts");
    expect(s).toContain('.select("slug, published")');
    expect(s).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
  });
});

describe("Settings > Texting", () => {
  it("says the exact line before Submit on the hosted path", () => {
    expect(HOSTED_POLICIES_LINE).toBe(
      "These pages are your business's Privacy Policy and Terms. Read them before you submit.",
    );
  });

  const page = read("src/routes/_authenticated/settings.sms.tsx");

  it("starts on the hosted page and offers the owner's own website as the option", () => {
    expect(page).toContain("useState<SiteChoice>(() => siteChoiceFor(initial))");
    expect(page).toContain("I have my own website");
    expect(page).toContain("Use my free ${HOSTED_SITE_HOST} page");
    // #969 review: the owner reads the pages before filing them.
    expect(page).toContain('target="_blank"');
    expect(page).toContain("{HOSTED_POLICIES_LINE}");
    // What is saved and submitted is the chosen site's URLs.
    expect(page).toMatch(/registrationDetailsSchema\.safeParse\(\{\s*\.\.\.filed,/);
    expect(page).toContain("saveFn({ data: { ...filed,");
  });
});
