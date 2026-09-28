// A converted lead kept only its name.
//
// Found 2026-09-27 by a tester playing an owner switching from Jobber. The demo
// seed's lead "Lauren Woods" says ZIP 10001, three dogs, weekly. "Convert to
// client" made a client with 0 properties, 0 services and status Inactive:
// convertLeadToClient copied name, email, phone and message, and put the
// message in `clients.notes`, which no screen displays. And a converted lead
// went on offering "Convert to client", because nothing recorded which client
// it had become.
//
// Now "Convert to client" opens the new-client wizard started from the lead,
// the wizard saves through onboardClient, and onboardClient links the lead to
// the client it made. These tests pin the mapping (pure, in
// src/lib/lead-conversion.ts), the "already converted" state, and the wiring
// that keeps a converted lead from being converted twice.

import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_PREFILL,
  MAX_WIZARD_DOGS,
  isSyntheticLeadEmail,
  leadConversionState,
  leadToWizardPrefill,
  normalizeLeadFrequency,
  parseLeadLocation,
  type ConvertibleLead,
} from "@/lib/lead-conversion";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** The seeded lead the tester converted, column for column
 *  (20260927030000_the-demo-day-was-always-tomorrow-after-dinner.sql). */
const LAUREN: ConvertibleLead = {
  id: "7d0c5c4e-0000-4000-8000-000000000003",
  name: "Lauren Woods",
  email: "lauren.w@example.com",
  phone: null,
  company: null,
  location: "10001",
  dog_count: 3,
  frequency: "weekly",
  message: "Big backyard, three dogs",
  source: "website",
  status: "new",
  converted_client_id: null,
};

describe("the lead the tester converted, as the wizard now receives it", () => {
  const p = leadToWizardPrefill(LAUREN);

  it("keeps the contact details", () => {
    expect(p.displayName).toBe("Lauren Woods");
    expect(p.primaryEmail).toBe("lauren.w@example.com");
    expect(p.primaryPhone).toBe("");
  });

  it("keeps the ZIP, in the ZIP field", () => {
    expect(p.postalCode).toBe("10001");
    // Nothing invented around it: the owner types the street on the Property
    // step, which is required anyway.
    expect([p.street, p.city, p.region]).toEqual(["", "", ""]);
  });

  it("keeps all three dogs, as three unnamed rows", () => {
    // Unnamed, not "Dog 1": tg_dogs_name_validate refuses placeholders, and a
    // name a tech cannot use is worse than none. The wizard prices from the
    // number of rows, so the count reaches the service either way.
    expect(p.dogs).toHaveLength(3);
    expect(p.dogs.every((d) => d.name === "")).toBe(true);
    // Three separate objects, not one shared three times: editing the first
    // dog's breed must not edit the other two.
    expect(new Set(p.dogs).size).toBe(3);
  });

  it("keeps the frequency", () => {
    expect(p.frequency).toBe("weekly");
  });

  it("keeps what they wrote, in the office note", () => {
    expect(p.officeNote).toContain("Big backyard, three dogs");
  });
});

describe("the mapping, at the edges the real data has", () => {
  const base = { ...LAUREN };

  it("a lead with no dog count still opens on one dog row, like a blank wizard", () => {
    expect(leadToWizardPrefill({ ...base, dog_count: null }).dogs).toHaveLength(1);
    expect(leadToWizardPrefill({ ...base, dog_count: 0 }).dogs).toHaveLength(1);
  });

  it("caps the rows at what onboardClient accepts, and keeps the real number in the note", () => {
    const p = leadToWizardPrefill({ ...base, dog_count: 45 });
    expect(p.dogs).toHaveLength(MAX_WIZARD_DOGS);
    expect(p.officeNote).toContain("Dogs reported: 45");
  });

  it("a frequency the Plan step does not offer is kept in the note, not guessed", () => {
    const p = leadToWizardPrefill({ ...base, frequency: "whenever it snows" });
    expect(p.frequency).toBeNull();
    expect(p.officeNote).toContain("Asked for: whenever it snows");
  });

  it("the company goes in the note, since the wizard has no field for it", () => {
    expect(leadToWizardPrefill({ ...base, company: "Oakwood HOA" }).officeNote).toContain(
      "Company: Oakwood HOA",
    );
  });

  it("an SMS lead's made-up address is not given to the client as an email", () => {
    // ai-receptionist.server.ts files SMS callers as `<digits>@sms.lead`
    // because leads.email is NOT NULL. As a primary email it would be sent the
    // welcome email.
    const p = leadToWizardPrefill({
      ...base,
      email: "15551234567@sms.lead",
      phone: "+15551234567",
      source: "sms_receptionist",
    });
    expect(p.primaryEmail).toBe("");
    expect(p.primaryPhone).toBe("+15551234567");
    expect(isSyntheticLeadEmail("15551234567@SMS.LEAD")).toBe(true);
    expect(isSyntheticLeadEmail("lauren.w@example.com")).toBe(false);
  });

  it("a lead with nothing to say leaves the note empty rather than a bare heading", () => {
    expect(leadToWizardPrefill({ ...base, message: null }).officeNote).toBe("");
  });

  it("lower-cases the email the way the old conversion and the lead API both did", () => {
    expect(leadToWizardPrefill({ ...base, email: "Lauren.W@Example.com " }).primaryEmail).toBe(
      "lauren.w@example.com",
    );
  });

  it("a blank wizard is still blank", () => {
    expect(EMPTY_PREFILL.displayName).toBe("");
    expect(EMPTY_PREFILL.dogs).toHaveLength(1);
    expect(EMPTY_PREFILL.frequency).toBeNull();
  });
});

describe("parseLeadLocation: the public form's 'Service address or ZIP'", () => {
  const loc = (s: string | null) => parseLeadLocation(s);

  it("a bare ZIP, the commonest case, is a ZIP", () => {
    expect(loc("78701")).toEqual({ street: "", city: "", region: "", postalCode: "78701" });
    expect(loc(" 10001-2345 ").postalCode).toBe("10001");
  });

  it("a five-digit street number is not a ZIP", () => {
    // The trap canvass-order.ts's splitter was written around.
    expect(loc("12345 Main St")).toEqual({
      street: "12345 Main St",
      city: "",
      region: "",
      postalCode: "",
    });
  });

  it("splits the full shape", () => {
    expect(loc("612 Maple St, Southfield, MI 48037")).toEqual({
      street: "612 Maple St",
      city: "Southfield",
      region: "MI",
      postalCode: "48037",
    });
    expect(loc("612 Maple St, Southfield, MI 48037, USA").postalCode).toBe("48037");
  });

  it("reads a state without a comma before it", () => {
    expect(loc("612 Maple St, Austin TX 78701")).toEqual({
      street: "612 Maple St",
      city: "Austin",
      region: "TX",
      postalCode: "78701",
    });
    expect(loc("Austin TX")).toEqual({ street: "", city: "Austin", region: "TX", postalCode: "" });
  });

  it("a town with only a ZIP after it is a town", () => {
    expect(loc("Brooklyn 11201")).toEqual({
      street: "",
      city: "Brooklyn",
      region: "",
      postalCode: "11201",
    });
  });

  it("does not read a street suffix as a state", () => {
    // Ct is Connecticut and Court; with no comma it is the street's.
    expect(loc("12 Oak Ct")).toEqual({ street: "12 Oak Ct", city: "", region: "", postalCode: "" });
    // St is not a state at all.
    expect(loc("40 Main St").region).toBe("");
  });

  it("keeps words it cannot place, in the street, rather than dropping them", () => {
    expect(loc("the yellow house by the park").street).toBe("the yellow house by the park");
  });

  it("nothing in, nothing out", () => {
    expect(loc(null)).toEqual({ street: "", city: "", region: "", postalCode: "" });
    expect(loc("   ")).toEqual({ street: "", city: "", region: "", postalCode: "" });
  });
});

describe("normalizeLeadFrequency", () => {
  it.each([
    ["weekly", "weekly"],
    ["Weekly", "weekly"],
    ["once a week", "weekly"],
    ["every week", "weekly"],
    ["biweekly", "biweekly"],
    ["bi-weekly", "biweekly"],
    ["every 2 weeks", "biweekly"],
    ["every other week", "biweekly"],
    ["twice a month", "biweekly"],
    ["twice_weekly", "twice_weekly"],
    ["twice a week", "twice_weekly"],
    ["2x/week", "twice_weekly"],
    ["monthly", "monthly"],
    ["once a month", "monthly"],
    ["one_time", "one_time"],
    ["one-time cleanup", "one_time"],
    ["once", "one_time"],
  ] as const)("%s -> %s", (raw, want) => {
    expect(normalizeLeadFrequency(raw)).toBe(want);
  });

  it("returns null for what it cannot place, so the wizard's own default stands", () => {
    expect(normalizeLeadFrequency("whenever it snows")).toBeNull();
    expect(normalizeLeadFrequency("")).toBeNull();
    expect(normalizeLeadFrequency(null)).toBeNull();
  });
});

describe("the already-converted state", () => {
  it("a new lead can be converted", () => {
    expect(leadConversionState({ status: "new", converted_client_id: null })).toEqual({
      kind: "convertible",
    });
    // Archived is not converted: a lead that came back can still become a client.
    expect(leadConversionState({ status: "archived", converted_client_id: null }).kind).toBe(
      "convertible",
    );
  });

  it("a converted lead with its client offers that client, not a second conversion", () => {
    expect(leadConversionState({ status: "converted", converted_client_id: "c-1" })).toEqual({
      kind: "linked",
      clientId: "c-1",
    });
  });

  it("the link outranks the status menu", () => {
    // Moved back to "contacted" after it became a client: still that client.
    expect(leadConversionState({ status: "contacted", converted_client_id: "c-1" }).kind).toBe(
      "linked",
    );
  });

  it("converted by hand, with no client, offers neither action", () => {
    expect(leadConversionState({ status: "converted", converted_client_id: null }).kind).toBe(
      "converted-unlinked",
    );
  });
});

describe("the wiring", () => {
  const leadsPage = read("src/routes/_authenticated/leads.tsx");
  const wizard = read("src/routes/_authenticated/clients.new.tsx");
  const leadsFns = read("src/lib/leads.functions.ts");
  const clientsFns = read("src/lib/clients.functions.ts");
  const server = read("src/lib/lead-conversion.server.ts");

  it("the one-tap conversion that kept only the name is gone", () => {
    expect(leadsFns).not.toMatch(/export const convertLeadToClient\b/);
    expect(leadsPage).not.toMatch(/convertLeadToClient/);
  });

  it("the leads page offers Convert only on a convertible lead, and Open client on a linked one", () => {
    expect(leadsPage).toMatch(/leadConversionState\(l\)/);
    expect(leadsPage).toMatch(/conversion\.kind === "convertible" && \(\s*<Button[^>]*onClick=\{\(\) => convert\(l\.id\)\}/);
    expect(leadsPage).toMatch(/conversion\.kind === "linked" && \(/);
    expect(leadsPage).toMatch(/Open client/);
    // No bare status check left deciding it: that is what let a lead moved
    // back from "converted" be converted a second time.
    expect(leadsPage).not.toMatch(/l\.status !== "converted"/);
  });

  it("Convert opens the wizard with the lead's id and nothing personal in the URL", () => {
    expect(leadsPage).toMatch(/navigate\(\{ to: "\/clients\/new", search: \{ fromLead: id \} \}\)/);
    // The wizard's search schema has exactly one key, and it must be a UUID.
    const validate = wizard.slice(wizard.indexOf("validateSearch"), wizard.indexOf("component: NewClientPage"));
    expect(validate).toMatch(/fromLead/);
    expect(validate).toMatch(/UUID\.test/);
    expect(validate).not.toMatch(/name|email|phone|location|zip/i);
  });

  it("the wizard remounts per lead, so one lead's answers cannot carry into another's", () => {
    // No draft is persisted anywhere; the remount is the whole guarantee.
    expect(wizard).toMatch(/<NewClientWizard\s+key=\{lead\.id\}/);
    expect(wizard).toMatch(/<NewClientWizard key="blank"/);
    // A use, not a mention: the wizard's comment says it keeps none.
    expect(wizard).not.toMatch(/\b(localStorage|sessionStorage)\s*\./);
  });

  it("the wizard refuses to open on a converted lead", () => {
    expect(wizard).toMatch(/state\.kind !== "convertible"/);
  });

  it("onboardClient checks the lead BEFORE it creates the client, and links it after", () => {
    const handler = clientsFns.slice(clientsFns.indexOf("export const onboardClient"));
    const check = handler.indexOf("assertConvertible(lead)");
    const insertClient = handler.indexOf('.from("clients")');
    const link = handler.indexOf("markLeadConverted(");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(insertClient);
    expect(link).toBeGreaterThan(insertClient);
    // Gated like the leads page itself.
    expect(handler.slice(0, check)).toMatch(/requirePermission\(supabase, userId, "manage_leads"\)/);
  });

  it("the link records which client, and cannot move an existing link", () => {
    expect(server).toMatch(/converted_client_id: clientId/);
    expect(server).toMatch(/\.is\("converted_client_id", null\)/);
    expect(server).toMatch(/status: "converted"/);
  });

  it("the lead's message becomes an office note, not the column nobody displays", () => {
    const handler = clientsFns.slice(clientsFns.indexOf("export const onboardClient"));
    expect(handler).toMatch(/from\("client_notes"\)\.insert\(\{[\s\S]*?audience: "office"/);
  });
});

describe("the migration", () => {
  const MIGRATIONS = join(ROOT, "supabase", "migrations");
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const file = files.find((f) => f.endsWith("_a-converted-lead-kept-only-its-name.sql"));
  const sql = file ? readFileSync(join(MIGRATIONS, file), "utf8") : "";

  it("exists", () => {
    expect(file).toBeDefined();
  });

  it("links a lead to its client, and a deleted client unlinks rather than blocks", () => {
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS converted_client_id uuid\s+REFERENCES public\.clients\(id\) ON DELETE SET NULL/,
    );
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS leads_converted_client_id_idx\s+ON public\.leads \(converted_client_id\)/);
  });

  it("is the latest leads INSERT policy, and refuses a submission that arrives already linked", () => {
    // Same test as the-lead-form-was-a-write-into-any-tenant.test.ts uses to
    // find the policy, so the two agree about which one is live.
    let latest = "";
    let latestFile = "";
    const re =
      /CREATE\s+POLICY[\s\S]*?ON\s+public\.leads[\s\S]*?FOR\s+INSERT[\s\S]*?;/gi;
    for (const f of files) {
      const m = readFileSync(join(MIGRATIONS, f), "utf8").match(re);
      if (m?.length) {
        latest = m[m.length - 1];
        latestFile = f;
      }
    }
    expect(latestFile).toBe(file);
    expect(latest).toMatch(/converted_client_id IS NULL/);
    expect(latest).toMatch(/converted_at IS NULL/);
    expect(latest).toMatch(/org_accepts_public_leads\(organization_id\)/);
  });

  it("asserts only what it creates, and prints the backfill rather than asserting it", () => {
    // CLAUDE.md: a number measured from a live database is a premise. The
    // backfill's count is one; it is a NOTICE, not an EXCEPTION.
    expect(sql).toMatch(/RAISE NOTICE 'converted leads linked to their client by the backfill: %'/);
    const post = sql.slice(sql.indexOf("DO $post$"));
    expect(post).not.toMatch(/count\(\*\)/i);
  });
});
