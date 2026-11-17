// #970: Settings → Texting opened empty, wanted exactly two authorized
// contacts, and onboarding never mentioned texting. Now:
//   - the form opens with the business name (as DBA), address, phone and
//     email from Business settings, and the owner as contact 1, and the
//     legal name is never prefilled from the DBA
//   - one authorized contact is required; a second is optional and filed
//     when given (the provisioning half is in
//     each-business-texts-in-its-own-name.test.ts)
//   - an owner holding Managed texting is offered "Text your clients" on the
//     onboarding checklist, done once the filing is under review or live

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  contactsToFile,
  ownerContact,
  splitName,
  splitUsAddress,
  NO_PREFILL,
} from "@/lib/texting-prefill";
import { registrationDetailsSchema } from "@/lib/texting-registration";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("the address Business settings keeps, in the parts a filing wants", () => {
  it.each([
    [
      "4200 Packard Street, Suite 2400, Ann Arbor, MI 48108, USA",
      ["4200 Packard Street", "Suite 2400", "Ann Arbor", "MI", "48108"],
    ],
    ["100 Main St, Ann Arbor, MI 48104", ["100 Main St", "", "Ann Arbor", "MI", "48104"]],
    ["12 Elm St, Austin, Texas 78701", ["12 Elm St", "", "Austin", "TX", "78701"]],
    ["12 Elm St, Austin, tx, 78701-1234", ["12 Elm St", "", "Austin", "TX", "78701-1234"]],
    ["5 Oak Ln\nPortland, OR 97201\nUnited States", ["5 Oak Ln", "", "Portland", "OR", "97201"]],
  ])("%s", (raw, [street, street2, city, region, postal_code]) => {
    expect(splitUsAddress(raw)).toEqual({ street, street2, city, region, postal_code });
  });

  it("does not guess: a line without a state and ZIP goes in Street whole", () => {
    expect(splitUsAddress("Somewhere near the lake")).toEqual({
      street: "Somewhere near the lake",
      street2: "",
      city: "",
      region: "",
      postal_code: "",
    });
    expect(splitUsAddress("1 Main St, Springfield")).toMatchObject({
      street: "1 Main St, Springfield",
      city: "",
    });
    expect(splitUsAddress(null).street).toBe("");
  });

  it("files a prefilled address that passes the form's own check", () => {
    const parts = splitUsAddress("100 Main St, Ann Arbor, MI 48104");
    const r = registrationDetailsSchema.safeParse({
      legal_name: "QA Test 970 LLC",
      business_type: "llc",
      ...parts,
      website_url: "https://qa-test-970.example.com",
      privacy_url: "https://qa-test-970.example.com/privacy",
      terms_url: "https://qa-test-970.example.com/terms",
      business_email: "devin@qa-test-970.example.com",
      business_phone: "313-555-0100",
      contacts: [
        ownerContact({
          ...NO_PREFILL,
          owner: {
            name: "Devin Doe",
            email: "devin@qa-test-970.example.com",
            phone: "313-555-0101",
          },
        }),
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe("the owner as authorized contact 1", () => {
  it("splits the name, and keeps a double-barrelled surname whole", () => {
    expect(splitName("Avery Testington-Abernathy")).toEqual({
      first_name: "Avery",
      last_name: "Testington-Abernathy",
    });
    expect(splitName("Mary Ann van der Berg")).toEqual({
      first_name: "Mary",
      last_name: "Ann van der Berg",
    });
    expect(splitName("Cher")).toEqual({ first_name: "Cher", last_name: "" });
    expect(splitName("  ")).toEqual({ first_name: "", last_name: "" });
  });

  it("is the owner's name, email and phone, titled Owner", () => {
    expect(
      ownerContact({
        ...NO_PREFILL,
        owner: { name: "Devin Doe", email: "devin@qa-test-970.example.com", phone: "" },
      }),
    ).toEqual({
      first_name: "Devin",
      last_name: "Doe",
      title: "Owner",
      email: "devin@qa-test-970.example.com",
      phone: "",
    });
    // Nothing known about the owner: nothing typed for them, title included.
    expect(ownerContact(NO_PREFILL).title).toBe("");
  });
});

describe("one contact required, a second optional", () => {
  const one = {
    first_name: "Devin",
    last_name: "Doe",
    title: "Owner",
    email: "d@x.com",
    phone: "3135550101",
  };
  const blank = { first_name: "", last_name: "", title: "", email: "", phone: " " };

  it("drops an untouched second contact and files a typed one", () => {
    expect(contactsToFile([one, blank])).toEqual([one]);
    expect(contactsToFile([one, { ...one, first_name: "Sam" }])).toHaveLength(2);
  });

  it("keeps a half-filled second contact so the check names what is missing", () => {
    expect(contactsToFile([one, { ...blank, first_name: "Sam" }])).toHaveLength(2);
  });

  it("never drops contact 1, even blank: the check says it is required", () => {
    expect(contactsToFile([blank, blank])).toEqual([blank]);
  });
});

describe("Settings → Texting opens filled in", () => {
  const page = codeOnly(read("src/routes/_authenticated/settings.sms.tsx"));
  const form = page.slice(
    page.indexOf("function formFrom("),
    page.indexOf("function TextingSettings"),
  );

  it("starts a new form from Business settings and the owner", () => {
    expect(form).toMatch(/dba:\s*s\.businessName/);
    expect(form).toMatch(/\.\.\.splitUsAddress\(s\.address\)/);
    expect(form).toMatch(/business_email:\s*s\.email/);
    expect(form).toMatch(/business_phone:\s*s\.phone/);
    expect(form).toMatch(/contacts:\s*\[ownerContact\(s\), emptyContact\(\)\]/);
  });

  it("never prefills the legal name, from the DBA or anything else", () => {
    for (const m of form.matchAll(/legal_name:\s*([^,\n]+)/g)) {
      expect(m[1].trim(), "legal_name is only ever what was saved, or empty").toMatch(
        /^(""|reg\?\.legal_name \?\? "")$/,
      );
    }
  });

  it("submits with an untouched second contact dropped", () => {
    expect(page).toMatch(/contacts:\s*contactsToFile\(form\.contacts\)/);
  });

  it("the server reads Business settings and the owner's staff row for it", () => {
    const fns = codeOnly(read("src/lib/texting-registration.functions.ts"));
    expect(fns).toMatch(/select\("name, contact_email, contact_phone, contact_address"\)/);
    expect(fns).toMatch(/\.eq\("role", "owner"\)/);
    expect(fns).toMatch(/select\("display_name, email, phone"\)/);
  });
});

// ── The onboarding step ───────────────────────────────────────────────────

vi.mock("@tanstack/react-start", () => {
  const builder = {
    middleware: () => builder,
    inputValidator: () => builder,
    handler: (fn: unknown) => fn,
  };
  return { createServerFn: () => builder, createServerOnlyFn: (fn: unknown) => fn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

let facts: { subscribed: boolean; state: string } | Error = {
  subscribed: false,
  state: "not_added",
};
vi.mock("@/lib/managed-texting.server", () => ({
  managedTextingFactsFor: async () => {
    if (facts instanceof Error) throw facts;
    return facts;
  },
}));

function context(lines: string[]) {
  const supabase = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      let cols = "";
      for (const m of ["gt", "not", "eq"]) q[m] = () => q;
      q.select = (c: string) => ((cols = c), q);
      const answer = () => {
        if (table === "user_roles") return { data: { organization_id: "org-a" } };
        if (table === "organizations") {
          if (cols === "service_lines") return { data: { service_lines: lines } };
          if (cols === "groom_setup_reviewed_at")
            return { data: { groom_setup_reviewed_at: null } };
          return { data: { contact_address: "1 Main St" } };
        }
        if (table === "services") return { data: [] };
        return { count: 0 };
      };
      q.maybeSingle = async () => answer();
      q.single = async () => answer();
      q.then = (res: (v: unknown) => unknown) => Promise.resolve(answer()).then(res);
      return q;
    },
  };
  return { supabase, userId: "owner" } as never;
}

const LINES: Record<string, string[]> = {
  scooping: ["pet_waste"],
  walking: ["dog_walking"],
  sitting: ["pet_sitting"],
  grooming: ["mobile_grooming"],
  training: ["training"],
  mixed: ["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "training"],
};

async function steps(lines: string[]) {
  const { loadOnboardingStatus } = await import("@/lib/onboarding.functions");
  const load = loadOnboardingStatus as unknown as (c: unknown) => Promise<{
    steps: Array<{ id: string; done: boolean; to: string; label: string }>;
    total: number;
  }>;
  return load(context(lines));
}

describe('"Text your clients" on the onboarding checklist', () => {
  it.each(Object.keys(LINES))("a %s business without the add-on is not offered it", async (k) => {
    facts = { subscribed: false, state: "not_added" };
    const r = await steps(LINES[k]);
    expect(r.steps.map((s) => s.id)).not.toContain("texting");
    expect(r.total).toBe(6);
  });

  it.each(Object.keys(LINES))("a %s business holding Managed texting is", async (k) => {
    facts = { subscribed: true, state: "needs_details" };
    const r = await steps(LINES[k]);
    const step = r.steps.find((s) => s.id === "texting");
    expect(step).toMatchObject({ label: "Text your clients", to: "/settings/sms", done: false });
    expect(r.steps.at(-1)?.id).toBe("texting");
    expect(r.total).toBe(7);
  });

  it.each([
    ["needs_details", false],
    ["needs_attention", false],
    ["under_review", true],
    ["active", true],
  ] as const)("state %s: done is %s", async (state, done) => {
    facts = { subscribed: true, state };
    const r = await steps(["pet_waste"]);
    expect(r.steps.find((s) => s.id === "texting")?.done).toBe(done);
  });

  it("a failed read offers nothing rather than a step", async () => {
    facts = new Error("no service role here");
    const r = await steps(["pet_waste"]);
    expect(r.steps.map((s) => s.id)).not.toContain("texting");
  });
});
