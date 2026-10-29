// Every email wears the brand of whoever sent it (#577).
//
// Before this the weekly digest, the invoices, the sign-in links and the
// team invite all looked the same: black text on white, no logo, no colour,
// and no line saying what product they came from. Three kinds of mail now
// have two kinds of chrome:
//
// - mail sent AS a business opens with its logo (or name) over a stripe in its
//   colour, and ends "Powered by HoundStack";
// - system mail opens with the HoundStack band and ends with the operator
//   line naming The North Consulting LLC;
// - the weekly digest is system mail about a business, so it has both: the
//   business's header and a footer that reads "Powered by HoundStack" above
//   the operator line.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as React from "react";
import { render } from "react-email";
import { TEMPLATES } from "@/lib/email-templates/registry";
import { OPERATOR_LINE, safeHexColor, safeLogoUrl } from "@/lib/email-templates/_brand";
import { existsSync } from "node:fs";
import { SignupEmail } from "@/lib/email-templates/signup";
import { InviteEmail } from "@/lib/email-templates/invite";
import { MagicLinkEmail } from "@/lib/email-templates/magic-link";
import { RecoveryEmail } from "@/lib/email-templates/recovery";
import { EmailChangeEmail } from "@/lib/email-templates/email-change";
import { ReauthenticationEmail } from "@/lib/email-templates/reauthentication";
import { TeamInviteEmail } from "@/lib/email-templates/team-invite";

const read = (p: string) => readFileSync(p, "utf8");

const LOGO = "https://cdn.example.test/riverbend-logo.png";
const brand = {
  orgName: "Riverbend Pet Services",
  orgLogoUrl: LOGO,
  orgBrandColor: "#7C3AED",
};

// The header is the reversed wordmark as an image, never typeset text.
const WORDMARK =
  '/brand/houndstack-wordmark-reversed.png" alt="HoundStack" width="234" height="28"';

const TENANT = Object.keys(TEMPLATES).filter((k) => k !== "weekly-digest");

async function html(component: React.ElementType, props: Record<string, unknown>) {
  return render(React.createElement(component, props));
}

describe("mail sent as a business", () => {
  it.each(TENANT)("%s opens with the business's logo and colour", async (name) => {
    const t = TEMPLATES[name];
    const out = await html(t.component, { ...(t.previewData ?? {}), ...brand });
    expect(out).toContain(`src="${LOGO}"`);
    expect(out).toContain('alt="Riverbend Pet Services"');
    expect(out).toContain("3px solid #7c3aed");
  });

  it.each(TENANT)("%s ends Powered by HoundStack", async (name) => {
    const t = TEMPLATES[name];
    const out = await html(t.component, { ...(t.previewData ?? {}), ...brand });
    expect(out).toMatch(/Powered by(<!-- -->)?\s*<a[^>]*>HoundStack<\/a>/);
  });

  it("falls back to the name over HoundStack green with no logo or colour", async () => {
    const t = TEMPLATES["payment-received"];
    const out = await html(t.component, { ...t.previewData, orgName: "Riverbend Pet Services" });
    expect(out).not.toContain("<img");
    expect(out).toContain("3px solid #267b4c");
    expect(out).toContain("Riverbend Pet Services");
  });

  it("enqueueAppEmail hands every template the logo and colour from the org row", () => {
    const src = read("src/lib/email/enqueue.server.ts");
    expect(src).toMatch(/contact_address, logo_url, brand_color/);
    expect(src).toMatch(/orgLogoUrl: orgContact\.logo_url \?\? null/);
    expect(src).toMatch(/orgBrandColor: orgContact\.brand_color \?\? null/);
  });
});

describe("what a tenant typed never reaches a style or src attribute unchecked", () => {
  it("accepts only #rgb and #rrggbb", () => {
    expect(safeHexColor("#ABC")).toBe("#aabbcc");
    expect(safeHexColor(" #7C3AED ")).toBe("#7c3aed");
    for (const bad of ["red", "rgb(0,0,0)", "#12345", '#fff" onload="x', "", null, undefined]) {
      expect(safeHexColor(bad as string | null | undefined)).toBeNull();
    }
  });

  it("accepts only https logos", () => {
    expect(safeLogoUrl(LOGO)).toBe(LOGO);
    for (const bad of [
      "http://x.test/a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AA",
      "/logo.png",
      "",
    ]) {
      expect(safeLogoUrl(bad)).toBeNull();
    }
  });

  it("drops a bad colour rather than printing it", async () => {
    const t = TEMPLATES["payment-received"];
    const out = await html(t.component, {
      ...t.previewData,
      orgBrandColor: "red;background:url(x)",
    });
    expect(out).not.toContain("url(x)");
    expect(out).toContain("3px solid #267b4c");
  });
});

describe("system mail", () => {
  const SYSTEM: Array<[string, React.ElementType, Record<string, unknown>]> = [
    [
      "signup",
      SignupEmail,
      {
        siteName: "HoundStack",
        siteUrl: "https://app.test",
        recipient: "a@b.test",
        confirmationUrl: "https://app.test/c",
      },
    ],
    [
      "invite",
      InviteEmail,
      {
        siteName: "HoundStack",
        siteUrl: "https://app.test",
        confirmationUrl: "https://app.test/c",
      },
    ],
    [
      "magic link",
      MagicLinkEmail,
      { siteName: "HoundStack", confirmationUrl: "https://app.test/c" },
    ],
    ["recovery", RecoveryEmail, { siteName: "HoundStack", confirmationUrl: "https://app.test/c" }],
    [
      "email change",
      EmailChangeEmail,
      {
        siteName: "HoundStack",
        oldEmail: "a@b.test",
        email: "a@b.test",
        newEmail: "c@d.test",
        confirmationUrl: "https://app.test/c",
      },
    ],
    ["reauthentication", ReauthenticationEmail, { token: "123456" }],
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

  it.each(SYSTEM)(
    "%s opens with the HoundStack band and names the operator",
    async (_n, C, props) => {
      const out = await html(C, props);
      expect(out).toContain("background-color:#142937");
      expect(out).toContain(WORDMARK);
      expect(out).toContain(OPERATOR_LINE);
      expect(out).not.toContain("Powered by");
    },
  );

  it("the operator line matches the public site word for word", () => {
    const footer = read("src/components/PublicFooter.tsx").replace(/\s+/g, " ");
    expect(footer).toContain(
      "{APP_NAME} is operated by The North Consulting LLC, 2222 West Grand River Avenue STE A, Okemos, MI 48864.",
    );
  });

  it("the team invite escapes the business name it used to paste into HTML", async () => {
    const out = await html(TeamInviteEmail, {
      orgName: "<b>Riverbend</b>",
      email: "a@b.test",
      roleLabel: "tech",
      link: "https://app.test/i",
    });
    expect(out).not.toContain("<b>Riverbend</b>");
    expect(out).toContain("&lt;b&gt;Riverbend&lt;/b&gt;");
  });
});

describe("the weekly digest", () => {
  it("has the business's header and a Powered by HoundStack footer with the operator", async () => {
    const t = TEMPLATES["weekly-digest"];
    const out = await html(t.component, { ...t.previewData, ...brand });
    expect(out).toContain(`src="${LOGO}"`);
    expect(out).toContain("3px solid #7c3aed");
    expect(out).toMatch(/Powered by(<!-- -->)?\s*<a[^>]*>HoundStack<\/a>/);
    expect(out).toContain(OPERATOR_LINE);
    expect(out).toContain("Settings → Emails");
  });

  it("sendDigestEmail reads the logo and colour off the org row", () => {
    const src = read("src/lib/digest.server.ts");
    expect(src).toMatch(/\.select\("logo_url, brand_color"\)/);
    expect(src).toMatch(/orgLogoUrl: brand\?\.logo_url \?\? null/);
  });
});

describe("platform mail built by hand", () => {
  it("the trial notice wears the HoundStack band and operator line, copy unchanged", async () => {
    const { renderTrialNoticeHtml } = await import("@/lib/trial-expiry-emails.server");
    const out = renderTrialNoticeHtml({
      orgName: "Riverbend Pet Services",
      daysLeft: 3,
      endsOn: "Nov 1, 2026",
      billingUrl: "https://app.test/settings/billing",
    });
    expect(out).toContain("background-color:#142937");
    expect(out).toContain(WORDMARK);
    expect(out).toContain(OPERATOR_LINE);
    expect(out).toContain(
      "Sent by HoundStack · You are receiving this because your workspace is in a free trial.",
    );
    expect(out).toContain("Your HoundStack trial ends in 3 days");
    expect(out).toContain("Plans start at $79 a month with your first teammate included.");
  });

  it("an announcement wears the HoundStack band and operator line", async () => {
    const { renderAnnouncementHtml } = await import("@/lib/announcement-emails.server");
    const out = renderAnnouncementHtml("Scheduled maintenance", "Sunday 2am to 3am.", "info");
    expect(out).toContain("background-color:#142937");
    expect(out).toContain(WORDMARK);
    expect(out).toContain(OPERATOR_LINE);
    expect(out).toContain("Sent by HoundStack · Platform announcement");
    expect(out).toContain("Scheduled maintenance");
  });
});

describe("the HoundStack header", () => {
  it("is the reversed wordmark on website navy with a sage rule", async () => {
    const out = await html(MagicLinkEmail, {
      siteName: "HoundStack",
      confirmationUrl: "https://app.test/c",
    });
    expect(out).toContain("background-color:#142937");
    expect(out).toContain("background-color:#5e845e");
    expect(out).toContain(WORDMARK);
    expect(out).not.toContain("filter:");
  });

  it("the image it points at ships in public/, as a PNG and its SVG source", () => {
    expect(existsSync("public/brand/houndstack-wordmark-reversed.png")).toBe(true);
    const svg = read("public/brand/houndstack-wordmark-reversed.svg");
    expect(svg).not.toContain("currentColor");
    expect(svg).toContain("fill:#ffffff");
    expect(svg).toContain("fill:#5e845e");
  });
});
