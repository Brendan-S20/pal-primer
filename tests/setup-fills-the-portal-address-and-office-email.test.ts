// D14, onboarding audit 2026-11-09: after all of setup, Settings > Client
// portal showed `app.houndstack.com/portal/` with nothing after the slash, and
// under Office email: "Add one. Invoices and reminders are sent from a
// no-reply address, so any client who hits Reply today is writing to nobody."
//
// Setup never asked for either. Step 1 now does, prefilled and editable: the
// portal address from the business name, the office email from the owner's
// own sign-in email. Both save with the rest of step 1, through the same
// server functions Settings > Client portal saves with (setPortalSlug or
// suggestPortalSlug, and updateOrgBranding's contactEmail).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  officeEmailPrefill,
  officeEmailWrite,
  portalSlugFromName,
  portalSlugPrefill,
  portalSlugWrite,
} from "@/lib/setup-prefill";
import { slugify } from "@/lib/portal-slug";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("the portal address", () => {
  it("is suggested from the business name", () => {
    expect(portalSlugFromName("Detroit Doo Disposal")).toBe("detroit-doo-disposal");
    expect(portalSlugFromName("Scoop & Go, LLC")).toBe("scoop-go-llc");
    expect(portalSlugFromName("ab")).toBe("");
    expect(portalSlugFromName("")).toBe("");
  });

  it("shows the saved address over a suggestion", () => {
    expect(portalSlugPrefill({ saved: "acme", name: "Something Else" })).toBe("acme");
    expect(portalSlugPrefill({ saved: null, name: "Poop Pros" })).toBe("poop-pros");
  });

  it("writes a typed address, keeps a saved one, and otherwise asks the server for a free one", () => {
    expect(portalSlugWrite({ saved: "acme", typed: null })).toEqual({ kind: "keep" });
    expect(portalSlugWrite({ saved: "acme", typed: "acme" })).toEqual({ kind: "keep" });
    expect(portalSlugWrite({ saved: "acme", typed: "Acme Yards" })).toEqual({
      kind: "set",
      slug: "acme-yards",
    });
    // Untouched on a new business: the server picks the name's slug, or the
    // nearest one free, so a name another business already has never blocks
    // step 1.
    expect(portalSlugWrite({ saved: null, typed: null })).toEqual({ kind: "suggest" });
    expect(portalSlugWrite({ saved: null, typed: "x" })).toEqual({ kind: "suggest" });
    expect(portalSlugWrite({ saved: "acme", typed: "" })).toEqual({ kind: "keep" });
  });

  it("uses one slug rule on both sides", () => {
    expect(read("src/lib/portal-links.server.ts")).toMatch(/from "@\/lib\/portal-slug"/);
    expect(slugify("  Hello  World!! ")).toBe("hello-world");
  });
});

describe("the office email", () => {
  it("is prefilled from the owner's sign-in email when none is saved", () => {
    expect(officeEmailPrefill({ saved: null, ownerEmail: "owner@example.com" })).toBe(
      "owner@example.com",
    );
    expect(officeEmailPrefill({ saved: "office@example.com", ownerEmail: "o@example.com" })).toBe(
      "office@example.com",
    );
    expect(officeEmailPrefill({ saved: null, ownerEmail: null })).toBe("");
  });

  it("saves the prefill on a new business, never overwrites a saved one untouched", () => {
    expect(officeEmailWrite({ saved: null, typed: null, ownerEmail: "o@example.com" })).toBe(
      "o@example.com",
    );
    expect(
      officeEmailWrite({ saved: "office@example.com", typed: null, ownerEmail: "o@example.com" }),
    ).toBeUndefined();
    expect(
      officeEmailWrite({ saved: null, typed: "hi@example.com ", ownerEmail: "o@example.com" }),
    ).toBe("hi@example.com");
    // Cleared on purpose is an answer.
    expect(officeEmailWrite({ saved: "a@example.com", typed: "", ownerEmail: null })).toBeNull();
  });
});

describe("setup step 1", () => {
  const setup = read("src/routes/_authenticated/setup.tsx");

  it("asks for both, prefilled", () => {
    expect(setup).toMatch(/id="setup-office-email"/);
    expect(setup).toMatch(/id="setup-portal-slug"/);
    expect(setup).toMatch(/authEmail/);
    expect(setup).toMatch(/officeEmailPrefill\(/);
    expect(setup).toMatch(/portalSlugPrefill\(/);
  });

  it("saves them through the portal settings' own server functions", () => {
    expect(setup).toMatch(/useServerFn\(setPortalSlug\)/);
    expect(setup).toMatch(/useServerFn\(suggestPortalSlug\)/);
    expect(setup).toMatch(/contactEmail:/);
    const cards = read("src/components/settings/ClientPortalCards.tsx");
    expect(cards).toMatch(/setPortalSlug/);
    expect(cards).toMatch(/contactEmail:/);
  });
});

describe("Settings > Client portal, for a business set up before this", () => {
  const cards = read("src/components/settings/ClientPortalCards.tsx");

  it("does not show an empty address: it suggests one from the name", () => {
    expect(cards).toMatch(/portalSlugFromName\(/);
  });

  it("offers the owner's own email in one tap where the office email is empty", () => {
    expect(cards).toMatch(/authEmail/);
    expect(cards).toMatch(/data-use-sign-in-email/);
  });
});
