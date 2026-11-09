// Every HoundStack email closes with the company signature (Nov 2026).
//
// Customer Success asked, on the owner's behalf, that system mail end the way
// the team's new Gmail signatures do: the HoundStack logo, name, tagline,
// support address, web link and the legal line naming The North Consulting
// LLC. Company-level means no person: the Gmail signature carries a name and
// a title, and this one never may.
//
// There is one copy of it, CompanySignature in email-templates/_brand.tsx.
// System mail reaches it through SystemLayout / SystemFooter /
// systemFooterHtml; tenant mail reaches its support, web and legal lines
// through PoweredByHoundStack. This file proves every path a HoundStack email
// can take ends up there, in the HTML and in the text part, and that nobody
// pasted a second copy somewhere else.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import * as React from "react";
import { render } from "react-email";
import { EMAIL_TEXT_OPTIONS } from "@/lib/email/plain-text";
import { TEMPLATES } from "@/lib/email-templates/registry";
import {
  COMPANY,
  COMPANY_SIGNATURE_TEXT,
  HOUNDSTACK_URL,
  SUPPORT_EMAIL,
  systemFooterHtml,
  systemFooterText,
} from "@/lib/email-templates/_brand";
import { SignupEmail } from "@/lib/email-templates/signup";
import { InviteEmail } from "@/lib/email-templates/invite";
import { MagicLinkEmail } from "@/lib/email-templates/magic-link";
import { RecoveryEmail } from "@/lib/email-templates/recovery";
import { EmailChangeEmail } from "@/lib/email-templates/email-change";
import { ReauthenticationEmail } from "@/lib/email-templates/reauthentication";
import { TeamInviteEmail } from "@/lib/email-templates/team-invite";

const LOGO = "https://www.houndstack.com/icon-192.png";
const LEGAL = "The North Consulting LLC, 2222 West Grand River Avenue, Ste A, Okemos, MI 48864";
const TAGLINE = "Business software for route-based pet service businesses";

/** Nothing personal: no founder's name, no title. */
function expectNoPerson(out: string) {
  expect(out).not.toMatch(/Brendan/i);
  expect(out).not.toMatch(/Schmidt/i);
  expect(out).not.toMatch(/Founder/i);
}

function expectSignatureHtml(out: string) {
  expect(out).toContain(`src="${LOGO}"`);
  expect(out).toMatch(/width="60" height="60"|height="60"[^>]*width="60"/);
  expect(out).toContain(`href="${HOUNDSTACK_URL}"`);
  expect(out).toContain(`href="mailto:${SUPPORT_EMAIL}"`);
  expect(out).toContain(">support@houndstack.com</a>");
  expect(out).toContain(">houndstack.com</a>");
  expect(out).toContain(TAGLINE);
  expect(out).toContain(LEGAL);
  expect(out).toContain("color:#142937");
  expectNoPerson(out);
}

/** The text part says the same things, one per line. */
function expectSignatureText(text: string) {
  expect(text).toContain("HoundStack");
  expect(text).toContain(TAGLINE);
  expect(text).toContain("Email: support@houndstack.com");
  expect(text).toMatch(/Web: houndstack\.com/);
  expect(text).toContain(LEGAL);
  expectNoPerson(text);
}

/** The auth hook's props (src/routes/email/auth/webhook.ts), one set. */
const AUTH_PROPS = {
  siteName: "HoundStack",
  siteUrl: "https://houndstack.com",
  recipient: "a@b.test",
  email: "a@b.test",
  confirmationUrl: "https://app.test/c",
  token: "123456",
  oldEmail: "a@b.test",
  newEmail: "c@d.test",
};

const SYSTEM: Array<[string, React.ElementType, Record<string, unknown>]> = [
  ["signup", SignupEmail, AUTH_PROPS],
  ["invite", InviteEmail, AUTH_PROPS],
  ["magic link", MagicLinkEmail, AUTH_PROPS],
  ["recovery", RecoveryEmail, AUTH_PROPS],
  ["email change", EmailChangeEmail, AUTH_PROPS],
  ["reauthentication", ReauthenticationEmail, AUTH_PROPS],
  [
    "team invite",
    TeamInviteEmail,
    {
      orgName: "Riverbend Pet Services",
      email: "a@b.test",
      roleLabel: "office manager",
      link: "https://app.test/invite/x",
    },
  ],
];

describe("the signature itself", () => {
  it("is the Gmail signature's content, company version", () => {
    expect(COMPANY.logoUrl).toBe(LOGO);
    expect(COMPANY.logoUrl).toMatch(/^https:\/\/.+\.png$/);
    expect(COMPANY.tagline).toBe(TAGLINE);
    expect(COMPANY.legalLine).toBe(LEGAL);
    expect(SUPPORT_EMAIL).toBe("support@houndstack.com");
    expect(HOUNDSTACK_URL).toBe("https://houndstack.com");
  });

  it("is built for email clients: tables and inline styles, no flex, grid, SVG or WebP", () => {
    const out = systemFooterHtml();
    expectSignatureHtml(out);
    expect(out).toContain("<table");
    expect(out).not.toMatch(/display:\s*(flex|grid)/);
    expect(out).not.toMatch(/<svg|\.svg"|\.webp"/);
    expect(out).not.toContain("<style");
    expect(out).toContain("mso-table-lspace:0pt");
  });

  it("has a plain-text twin with the same lines", () => {
    expectSignatureText(COMPANY_SIGNATURE_TEXT);
    expect(COMPANY_SIGNATURE_TEXT).toContain("Web: houndstack.com (https://houndstack.com)");
    expectSignatureText(systemFooterText("Why you got this."));
    expect(systemFooterText("Why you got this.")).toMatch(/^Why you got this\.\n\n-- \n/);
  });
});

describe("system mail, including every template the auth send-email hook renders", () => {
  it.each(SYSTEM)("%s closes with the company signature in HTML", async (_n, C, props) => {
    expectSignatureHtml(await render(React.createElement(C, props)));
  });

  it.each(SYSTEM)("%s closes with the company signature in its text part", async (_n, C, props) => {
    expectSignatureText(await render(React.createElement(C, props), EMAIL_TEXT_OPTIONS));
  });

  it("the auth hook renders those templates and pastes no footer of its own", () => {
    const src = readFileSync("src/routes/email/auth/webhook.ts", "utf8");
    for (const t of [
      "signup",
      "invite",
      "magic-link",
      "recovery",
      "email-change",
      "reauthentication",
    ]) {
      expect(src).toContain(`@/lib/email-templates/${t}"`);
    }
    expect(src).toContain("render(element, EMAIL_TEXT_OPTIONS)");
    expect(src).not.toContain("North Consulting");
    expect(src).not.toContain("icon-192");
  });
});

describe("mail sent as a business ends with the company's support, web and legal lines", () => {
  const brand = { orgName: "Riverbend Pet Services", orgEmail: "hi@riverbend.test" };
  const names = Object.keys(TEMPLATES);

  it.each(names)("%s", async (name) => {
    const t = TEMPLATES[name];
    const el = React.createElement(t.component, { ...(t.previewData ?? {}), ...brand });
    const out = await render(el);
    expect(out).toMatch(/Powered by(<!-- -->)?\s*<a[^>]*>HoundStack<\/a>/);
    expect(out).toContain(`href="mailto:${SUPPORT_EMAIL}"`);
    expect(out).toContain(`href="${HOUNDSTACK_URL}"`);
    expect(out).toContain(TAGLINE);
    expect(out).toContain(LEGAL);
    // The business's own logo opens tenant mail; the HoundStack logo does not
    // compete with it at the bottom.
    expect(out).not.toContain(LOGO);
    expectNoPerson(out);
    expectSignatureText(await render(el, EMAIL_TEXT_OPTIONS));
  });
});

describe("platform mail built by hand", () => {
  it("the trial notice, HTML and text", async () => {
    const m = await import("@/lib/trial-expiry-emails.server");
    const input = {
      orgName: "Riverbend Pet Services",
      daysLeft: 3,
      endsOn: "Nov 1, 2026",
      billingUrl: "https://app.test/settings/billing",
    };
    expectSignatureHtml(m.renderTrialNoticeHtml(input));
    expectSignatureText(m.renderTrialNoticeText(input));
  });

  it("an announcement, HTML and text", async () => {
    const m = await import("@/lib/announcement-emails.server");
    expectSignatureHtml(m.renderAnnouncementHtml("Maintenance", "Sunday 2am.", "info"));
    const text = m.renderAnnouncementText("Maintenance", "Sunday 2am.");
    expect(text.startsWith("Maintenance\n\nSunday 2am.\n\n")).toBe(true);
    expectSignatureText(text);
  });

  it("every hand-built email takes the footer from _brand rather than a copy", () => {
    for (const f of [
      "src/lib/trial-expiry-emails.server.ts",
      "src/lib/announcement-emails.server.ts",
      "src/lib/setup-notify.server.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("systemFooterHtml(");
      expect(src, f).toContain("systemFooterText(");
    }
  });
});

describe("one copy", () => {
  it("only _brand.tsx spells the legal line or the logo URL", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) {
          const src = readFileSync(p, "utf8");
          if (src.includes("2222 West Grand River Avenue, Ste A") || src.includes("icon-192.png"))
            hits.push(p);
        }
      }
    };
    walk("src");
    expect(hits).toEqual(["src/lib/email-templates/_brand.tsx"]);
  });
});
