import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "react-email";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES } from "@/lib/email-templates/registry";

// A client puts a card on file from a link, with nobody in the office.
//
// The portal's Billing tab has had an embedded card form (a SetupIntent on the
// business's connected account) for a while, but nothing pointed at it. The
// declined-card email said "Update card or pay" and landed on the portal's
// home page; the invoice email never mentioned a card at all. So in practice a
// card got on file when somebody in the office opened Take payment.
//
// Now every link that is about the card goes to /billing?card=update, and the
// billing route opens the form when it sees that.

const ORG = "11111111-1111-1111-1111-111111111111";
const TOKEN = "22222222-2222-2222-2222-222222222222";

const state = vi.hoisted(() => ({ slug: "detroit-doo" as string | null }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        neq: () => q,
        update: () => q,
        maybeSingle: async () => ({
          data: { id: ORG, name: "Detroit Doo Disposal", portal_slug: state.slug },
          error: null,
        }),
      };
      return q;
    },
  },
}));

describe("the portal card link", () => {
  it("goes to the Billing tab with the card form open", async () => {
    state.slug = "detroit-doo";
    const { buildPortalCardLink, buildPortalBillingLink } =
      await import("@/lib/portal-links.server");
    expect(await buildPortalCardLink(ORG, TOKEN)).toMatch(
      new RegExp(`/portal/detroit-doo/${TOKEN}/billing\\?card=update$`),
    );
    expect(await buildPortalBillingLink(ORG, TOKEN)).toMatch(
      new RegExp(`/portal/detroit-doo/${TOKEN}/billing$`),
    );
  });

  it("uses a slug it is handed without looking one up", async () => {
    state.slug = null;
    const { buildPortalCardLink } = await import("@/lib/portal-links.server");
    expect(await buildPortalCardLink(ORG, TOKEN, "known-slug")).toContain(
      `/portal/known-slug/${TOKEN}/billing?card=update`,
    );
  });

  it("is no link at all without a token", async () => {
    const { buildPortalCardLink, buildPortalBillingLink } =
      await import("@/lib/portal-links.server");
    expect(await buildPortalCardLink(ORG, null)).toBeUndefined();
    expect(await buildPortalBillingLink(ORG, undefined)).toBeUndefined();
  });
});

describe("the invoice email", () => {
  const base = { orgName: "Detroit Doo Disposal", amountCents: 8500, invoiceUrl: "https://x/pay" };

  it("offers the card form when it is given one", async () => {
    const cardUrl = `https://app.example/portal/detroit-doo/${TOKEN}/billing?card=update`;
    const html = await render(
      createElement(TEMPLATES["invoice-sent"].component, { ...base, cardUrl }),
    );
    expect(html).toContain("Save a card in your account");
    expect(html).toContain(`/billing?card=update`);
    expect(html).not.toContain(String.fromCharCode(0x2014));
  });

  it("reads as it always did when the client already has a card", async () => {
    const html = await render(createElement(TEMPLATES["invoice-sent"].component, base));
    expect(html).not.toContain("Save a card");
    expect(html).not.toContain("card=update");
  });

  it("is only given the link when the client has no card on file, from both senders", () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    for (const file of [
      "src/lib/notifications.functions.ts",
      "src/routes/api/public/hooks/nightly.ts",
    ]) {
      const src = read(file);
      expect(src, file).toMatch(/clients\(portal_token, default_payment_method_id\)/);
      expect(src, file).toMatch(/!inv\.clients\.default_payment_method_id/);
      expect(src, file).toMatch(/buildPortalCardLink/);
    }
  });
});

describe("the billing route", () => {
  const src = readFileSync(
    join(process.cwd(), "src/routes/portal.$slug.$token.billing.tsx"),
    "utf8",
  );

  it("reads ?card=update and opens the card form with it", () => {
    expect(src).toMatch(/search\.card === "update"/);
    expect(src).toMatch(/useState\(card === "update"\)/);
  });

  it("drops the parameter once the card is saved, so a refresh does not reopen the form", () => {
    const onDone = src.slice(
      src.indexOf("<CardSetup"),
      src.indexOf("</div>", src.indexOf("<CardSetup")),
    );
    expect(onDone).toMatch(/clearCardParam\(\)/);
  });
});
