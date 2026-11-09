// R2-50: three faults in the mail a business sends its customers.
//
// - "Thanks for choosing Summit Paws Co.." when the name ends in a period.
// - "Reply to this email" from noreply@ when the business has no contact
//   email, so the message has no reply-to and the answer reaches nobody.
// - The text part ran the footer together on one line:
//   "Summit Paws Co.(303) 555-0142 tel:30355501421550 Blake St".

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as React from "react";
import { TEMPLATES } from "@/lib/email-templates/registry";
import { howToReach, noEndPeriod, sentence } from "@/lib/email-templates/_shared";
import { renderEmailText } from "@/lib/email/plain-text";

const DOTTED = "Summit Paws Co.";
const PHONE = "(303) 555-0142";

async function text(name: string, props: Record<string, unknown>) {
  const t = TEMPLATES[name];
  return renderEmailText(React.createElement(t.component, { ...(t.previewData ?? {}), ...props }));
}

const TENANT = Object.keys(TEMPLATES).filter((k) => k !== "weekly-digest");

// A campaign's body is what the owner typed, so the preview's "Reply to this
// email" is theirs, not ours. Every other prop comes from the preview, plus
// the quote's reminder branch, which has its own line.
const OURS = { body: "Spring cleanups are open.", reminder: true };

describe("the phrases", () => {
  it("takes a name's own period off before closing the sentence", () => {
    expect(noEndPeriod(DOTTED)).toBe("Summit Paws Co");
    expect(sentence(`contact ${DOTTED}`)).toBe("contact Summit Paws Co.");
  });

  it("says reply only when a reply reaches someone", () => {
    expect(howToReach({ orgEmail: "hi@summit.test", orgPhone: PHONE })).toBe("reply to this email");
    expect(howToReach({ orgEmail: " ", orgPhone: PHONE })).toBe(`call ${PHONE}`);
    expect(howToReach({ orgName: DOTTED })).toBe("contact Summit Paws Co");
    expect(howToReach({})).toBe("contact us");
  });
});

describe("no email a business sends ends a name in two periods", () => {
  it.each(TENANT)("%s", async (name) => {
    const out = await text(name, { orgName: DOTTED, clientName: "Jane" });
    expect(out).not.toMatch(/Co\.\./);
  });
});

describe("no email a business sends says reply when there is no reply-to", () => {
  it.each(TENANT)("%s with a phone on file", async (name) => {
    const out = await text(name, { ...OURS, orgName: DOTTED, orgPhone: PHONE, orgEmail: null });
    expect(out.toLowerCase()).not.toContain("reply to this email");
  });

  it.each(TENANT)("%s with nothing on file", async (name) => {
    const out = await text(name, { ...OURS, orgName: DOTTED, orgPhone: null, orgEmail: null });
    expect(out.toLowerCase()).not.toContain("reply to this email");
  });

  it("still says reply when the business has a contact email", async () => {
    const out = await text("welcome", { orgName: DOTTED, orgEmail: "hi@summit.test" });
    expect(out).toContain("Reply to this email if you have questions.");
  });

  it("gives the phone instead when that is all there is", async () => {
    const out = await text("welcome", {
      ...OURS,
      orgName: DOTTED,
      orgPhone: PHONE,
      orgEmail: null,
    });
    expect(out).toContain(`Call ${PHONE} if you have questions.`);
  });

  it("enqueue only sets a reply-to from the contact email, which is what the copy keys on", () => {
    const src = readFileSync("src/lib/email/enqueue.server.ts", "utf8");
    expect(src).toMatch(/contact_email \? \{ reply_to: \(org as any\)\.contact_email \}/);
    expect(src).toContain("orgEmail: orgContact.contact_email ?? null");
  });
});

describe("the text part puts each footer line on its own line", () => {
  it("does not run the contact block together", async () => {
    const out = await text("welcome", {
      orgName: DOTTED,
      orgPhone: PHONE,
      orgEmail: "hi@summit.test",
      orgAddress: "1550 Blake St",
    });
    const lines = out.split("\n").map((l) => l.trim());
    expect(lines).toContain(PHONE);
    expect(lines).toContain("hi@summit.test");
    expect(lines).toContain("1550 Blake St");
    expect(out).not.toContain("tel:");
    expect(out).not.toContain("mailto:");
  });

  it("every place that renders a text part uses the shared options", () => {
    for (const f of [
      "src/lib/email/enqueue.server.ts",
      "src/lib/digest.server.ts",
      "src/lib/invite-email.server.ts",
      "src/routes/email/transactional/send.ts",
      "src/routes/email/auth/webhook.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toContain("plainText: true");
      expect(src, f).toContain("EMAIL_TEXT_OPTIONS");
    }
  });
});
