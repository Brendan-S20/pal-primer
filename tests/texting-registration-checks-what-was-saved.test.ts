// Post-merge should-fixes from HoundStack Product's Nov 24 reviews of the
// texting registration work:
//   #985 (review 6039947939): the server refuses no EIN when the SAVED draft
//        says LLC, corporation, partnership or nonprofit, so the check does
//        not rest only on the browser sending picked_business_type.
//   #979 (review 6039948207): the owner's own read of the registration gets
//        the same scrub the admin queue applies to last_error and
//        rejection_reason.
//   #978 (review 6039948095): Settings > Reviews tells the owner to keep the
//        link and the STOP line in an edited review-request template.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAdmin } from "./helpers/fake-supabase";
import * as tr from "@/lib/texting-registration";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

vi.mock("@tanstack/react-start", () => {
  const builder = {
    middleware: () => builder,
    inputValidator: () => builder,
    handler: (fn: unknown) => fn,
  };
  return { createServerFn: () => builder, createServerOnlyFn: (fn: unknown) => fn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

const ORG = "0a985000-0000-4000-8000-000000000001";
const fake = createFakeAdmin();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => fake.admin[p as keyof typeof fake.admin] }),
}));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: async () => ({ orgId: ORG, role: "owner" }),
}));
vi.mock("@/lib/managed-texting.server", () => ({ orgHoldsManagedTexting: async () => true }));
vi.mock("@/lib/twilio-credentials.server", () => ({ orgCanTextClients: async () => false }));
vi.mock("@/lib/texting-hosted-site.server", () => ({ hostedSiteRefusal: async () => null }));
const filed: unknown[] = [];
vi.mock("@/lib/twilio-provisioning.server", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/twilio-provisioning.server")>()),
  submitTextingRegistration: async (args: unknown) => {
    filed.push(args);
    return { status: "submitted" };
  },
}));

const fns = () => import("@/lib/texting-registration.functions");
const ctx = { context: { supabase: {}, userId: "qa-owner-1" } };

/** What Settings sends for a filing without an EIN, with picked_business_type
 *  left OUT: a request that did not come from the Settings form. */
const NO_EIN = {
  legal_name: "Avery Tester",
  business_type: "sole_proprietor",
  has_ein: false,
  dba: "QA TEST 985",
};

function seedDraft(businessType: string) {
  fake.reset({
    org_texting_registrations: [
      {
        organization_id: ORG,
        status: "draft",
        business_type: businessType,
        updated_at: "2026-11-20T10:00:00Z",
      },
    ],
  });
}

describe("#985: no EIN is refused while the saved draft names an entity type", () => {
  beforeEach(() => {
    filed.length = 0;
  });

  it("the rule: entity types refuse, a sole proprietor or nothing saved does not", () => {
    for (const t of ["llc", "corporation", "partnership", "nonprofit"]) {
      expect(tr.savedEntityRefusesNoEin(t, { has_ein: false }), t).toBe(tr.NO_EIN_NOT_SOLE_PROP);
      // With an EIN the saved type is simply the type filed.
      expect(tr.savedEntityRefusesNoEin(t, { has_ein: true }), t).toBeNull();
      expect(tr.savedEntityRefusesNoEin(t, {}), t).toBeNull();
    }
    expect(tr.savedEntityRefusesNoEin("sole_proprietor", { has_ein: false })).toBeNull();
    expect(tr.savedEntityRefusesNoEin(null, { has_ein: false })).toBeNull();
    expect(tr.savedEntityRefusesNoEin("", { has_ein: false })).toBeNull();
  });

  for (const saved of ["llc", "corporation", "partnership", "nonprofit"]) {
    it(`submit refuses a no-EIN filing over a saved ${saved} draft, without picked_business_type`, async () => {
      seedDraft(saved);
      const { submitTextingRegistration } = await fns();
      await expect(
        (submitTextingRegistration as any)({ data: { details: NO_EIN, ein: null }, ...ctx }),
      ).rejects.toThrow(tr.NO_EIN_NOT_SOLE_PROP);
      expect(filed).toHaveLength(0);
    });
  }

  it("submit files a no-EIN filing over a saved sole proprietor draft", async () => {
    seedDraft("sole_proprietor");
    const { submitTextingRegistration } = await fns();
    await expect(
      (submitTextingRegistration as any)({ data: { details: NO_EIN, ein: null }, ...ctx }),
    ).resolves.toEqual({ status: "submitted" });
    expect(filed).toHaveLength(1);
  });

  it("an LLC with an EIN still files over a saved LLC draft", async () => {
    seedDraft("llc");
    const { submitTextingRegistration } = await fns();
    await expect(
      (submitTextingRegistration as any)({
        data: { details: { ...NO_EIN, business_type: "llc", has_ein: true }, ein: "12-3456789" },
        ...ctx,
      }),
    ).resolves.toEqual({ status: "submitted" });
  });

  it("Settings keeps its Submit gate, and saves the corrected type before an honest no-EIN submit", () => {
    const page = read("src/routes/_authenticated/settings.sms.tsx");
    expect(page).toMatch(/disabled=\{busy \|\| !isOwner \|\| needsAddon \|\| entityWithoutEin\}/);
    const submit = page.slice(page.indexOf("const submit = useMutation"));
    const save = submit.indexOf("savedEntityRefusesNoEin(initial.business_type, filed)");
    expect(save).toBeGreaterThan(-1);
    expect(save).toBeLessThan(submit.indexOf("return submitFn("));
  });
});

describe("#979: the owner's own read is scrubbed like the admin queue", () => {
  it("masks a Twilio SID in last_error and rejection_reason saved before scrub knew SIDs", async () => {
    fake.reset({
      org_texting_registrations: [
        {
          organization_id: ORG,
          status: "rejected",
          legal_name: "QA TEST 979 LLC",
          last_error:
            "Twilio said: Bundle BU" +
            "a".repeat(32) +
            " is not compliant for /Accounts/AC" +
            "b".repeat(32),
          rejection_reason: "Profile HH" + "c".repeat(32) + " was rejected.",
        },
      ],
      organizations: [{ id: ORG, name: "QA TEST 979", contact_email: null, contact_phone: null }],
    });
    const { getTextingRegistration } = await fns();
    const r = await (getTextingRegistration as any)(ctx);
    expect(r.registration.last_error).toBe(
      "Twilio said: Bundle [id] is not compliant for /Accounts/[id]",
    );
    expect(r.registration.rejection_reason).toBe("Profile [id] was rejected.");
    expect(JSON.stringify(r)).not.toMatch(/\b(AC|HH|BU|PN|IT)[0-9a-f]{32}\b/);
  });

  it("leaves an empty error empty and a registration-less business null", async () => {
    fake.reset({ organizations: [{ id: ORG, name: "QA TEST 979" }] });
    const { getTextingRegistration } = await fns();
    expect((await (getTextingRegistration as any)(ctx)).registration).toBeNull();
  });
});

describe("#978: Settings > Reviews asks an edited template to keep the link and STOP line", () => {
  it("says so under the template", () => {
    const page = read("src/routes/_authenticated/settings.reviews.tsx");
    expect(page).toMatch(
      /If you edit it, keep <code>\{"\{link\}"\}<\/code> and the line "Reply STOP to opt out\."/,
    );
    expect(page).not.toMatch(/—/);
  });
});
