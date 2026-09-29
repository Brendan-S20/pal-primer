// A campaign says what was typed, and nothing else.
//
// The office writes a subject, a heading, a plain-text body and at most one
// button. None of it is HTML: the body is split into paragraphs and lines by
// bodyParagraphs and rendered as React text children, which escape every
// character. So `<script>` typed into a campaign arrives in the inbox as the
// eight characters `<script>`, and a button can only go to https.
//
// Also here: the template renders at all, with the business's footer (the
// postal address CAN-SPAM wants) and the unsubscribe link.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { render } from "react-email";
import { TEMPLATES } from "@/lib/email-templates/registry";
import {
  bodyParagraphs,
  campaignContentSchema,
  isSafeButtonUrl,
  normalizeContent,
} from "@/lib/campaigns";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const entry = TEMPLATES.campaign;
const renderCampaign = (props: Record<string, unknown>) =>
  render(React.createElement(entry.component, { ...entry.previewData, ...props }));

describe("the template renders", () => {
  it("is registered as `campaign`", () => {
    expect(entry).toBeDefined();
    expect(entry.displayName).toBe("Campaign");
  });

  it("with the heading, every paragraph, the button, the unsubscribe link and the footer", async () => {
    const html = await renderCampaign({});
    const d = entry.previewData!;
    expect(html).toContain("Spring is here, and so is everything the snow was hiding");
    expect(html).toContain("Book a one-time spring deep clean before April 30");
    expect(html).toContain("Reply to this email or use the button below.");
    expect(html).toContain('href="https://example.com/spring"');
    expect(html).toContain("Book a deep clean");
    expect(html).toContain(`href="${d.unsubscribeUrl}"`);
    expect(html).toContain("Unsubscribe from these emails");
    // OrgFooter: the business's name, phone, email and postal address.
    expect(html).toContain("Acme Scoop Co.");
    expect(html).toContain("1200 W Wilson Ave, Chicago, IL 60640");
    expect(html).toContain("(555) 010-0199");
  });

  it("the subject is the owner's own words", () => {
    const subject = entry.subject as (d: Record<string, unknown>) => string;
    expect(subject({ subject: "  Holiday schedule  ", orgName: "Acme" })).toBe("Holiday schedule");
    expect(subject({ subject: "", orgName: "Acme" })).toBe("News from Acme");
  });

  it("renders to plain text too, as every queued email does", async () => {
    const text = await render(React.createElement(entry.component, entry.previewData), {
      plainText: true,
    });
    expect(text).toContain("Book a one-time spring deep clean");
    expect(text).toContain("Unsubscribe from these emails");
  });

  it("with no button when there is none", async () => {
    const html = await renderCampaign({ buttonLabel: null, buttonUrl: null });
    expect(html).not.toContain("Book a deep clean");
  });
});

describe("no HTML from the office reaches the email", () => {
  const hostile = '<script>alert("x")</script><img src=x onerror=alert(1)> & <b>bold</b>';

  it("in the body", async () => {
    const html = await renderCampaign({ body: hostile });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("in the heading and the button label", async () => {
    const html = await renderCampaign({ heading: hostile, buttonLabel: hostile });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("because nothing in the path interprets it", () => {
    // Comment lines stripped: campaigns.ts names the API in order to say it
    // is never used.
    const code = (src: string) =>
      src
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
    for (const f of ["src/lib/email-templates/campaign.tsx", "src/lib/campaigns.ts"]) {
      expect(code(read(f)), f).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    }
  });

  it("paragraphs and line breaks are the only formatting", () => {
    expect(bodyParagraphs("One\r\ntwo\n\n\n  Three  \n\n \n")).toEqual([["One", "two"], ["Three"]]);
    expect(bodyParagraphs("   \n\n  ")).toEqual([]);
  });

  it("a button goes to https or nowhere", async () => {
    for (const bad of [
      "javascript:alert(1)",
      "http://example.com",
      "https://",
      "https://localhost",
      "https://user:pw@example.com",
      "https://exa mple.com",
      "data:text/html,<script>alert(1)</script>",
      "//example.com",
    ]) {
      expect(isSafeButtonUrl(bad), bad).toBe(false);
      const parsed = campaignContentSchema.safeParse({
        subject: "s",
        heading: "",
        body: "b",
        buttonLabel: "Go",
        buttonUrl: bad,
      });
      expect(parsed.success, bad).toBe(false);
      // And the template drops it even if one got past the form.
      const html = await renderCampaign({ buttonLabel: "Go now", buttonUrl: bad });
      expect(html, bad).not.toContain("Go now");
    }
    expect(isSafeButtonUrl("https://example.com/spring?utm=email#book")).toBe(true);
  });

  it("the subject is one line, because it is a header", () => {
    const parsed = campaignContentSchema.safeParse({
      subject: "Hello\r\nBcc: everyone@example.com",
      heading: "",
      body: "b",
      buttonLabel: null,
      buttonUrl: null,
    });
    expect(parsed.success).toBe(false);
    expect(
      read("supabase/migrations/20260929070000_nobody-could-send-a-seasonal-offer.sql"),
    ).toMatch(/CHECK \(subject !~ '\[\\r\\n\]'\)/);
  });

  it("a button needs both halves, and blank halves are no button", () => {
    const base = { subject: "s", heading: "", body: "b" };
    expect(
      campaignContentSchema.safeParse({ ...base, buttonLabel: "Go", buttonUrl: null }).success,
    ).toBe(false);
    expect(
      campaignContentSchema.safeParse({
        ...base,
        buttonLabel: null,
        buttonUrl: "https://example.com",
      }).success,
    ).toBe(false);
    expect(normalizeContent({ ...base, buttonLabel: "  ", buttonUrl: "  " })).toMatchObject({
      buttonLabel: null,
      buttonUrl: null,
    });
  });
});
