import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  importPlanRow,
  mapBalanceRow,
  mapServiceRow,
  matchImportService,
  newServiceDraft,
  parseTags,
  type ImportService,
} from "@/lib/import-services";
import { serviceLinesOrDefault } from "@/lib/service-lines";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// Bulk import creates/overwrites client data — every function in this file
// is gated on manage_imports, matching the /imports route boundary.
async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  return (await requirePermission(supabase, userId, "manage_imports")).orgId;
}

export const IMPORT_SOURCES = [
  "generic_csv",
  "sweepgo",
  "jobber",
  "housecall_pro",
  "time_to_pet",
  "gorilla_desk",
  "quoteiq_family",
] as const;

export const IMPORT_ENTITIES = ["clients", "properties", "dogs", "services", "balances"] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

// ---------- Target fields per entity ----------

export const CLIENT_TARGET_FIELDS = [
  "display_name",
  "account_type",
  "primary_email",
  "primary_phone",
  "external_id",
  "notes",
  // Service address — captured here so a Clients import (the primary migration
  // path off Sweep&Go/Jobber/Housecall) produces clients WITH a property,
  // instead of silently dropping the address (finding #12).
  "street",
  "city",
  "region",
  "postal_code",
  "gate_code",
  // Jobber's Tags ("Weekly; Tuesday; VIP") used to be folded into notes.
  "tags",
] as const;
export type ClientTargetField = (typeof CLIENT_TARGET_FIELDS)[number];

export const PROPERTY_TARGET_FIELDS = [
  "client_external_id",
  "label",
  "street",
  "city",
  "region",
  "postal_code",
  "gate_code",
  "notes",
] as const;
export type PropertyTargetField = (typeof PROPERTY_TARGET_FIELDS)[number];

export const DOG_TARGET_FIELDS = [
  "client_external_id",
  "name",
  "breed",
  "weight_class",
  "notes",
] as const;
export type DogTargetField = (typeof DOG_TARGET_FIELDS)[number];

// A recurring plan per row, and an opening balance per row. Both find their
// client by the old system's id, or by exact name when the export has none.
// See src/lib/import-services.ts.
export const SERVICE_TARGET_FIELDS = [
  "client_external_id",
  "client_name",
  "frequency",
  "price_per_visit",
  "service_day",
  "start_date",
  "dog_count",
  "billing",
  // Which of the business's services the plan is for (the catalog). Optional:
  // left unmapped, every plan is the business's default service, as before.
  "service",
] as const;

export const BALANCE_TARGET_FIELDS = [
  "client_external_id",
  "client_name",
  "amount",
  "due_date",
  "note",
] as const;

export const TARGET_FIELDS_BY_ENTITY: Record<ImportEntity, readonly string[]> = {
  clients: CLIENT_TARGET_FIELDS,
  properties: PROPERTY_TARGET_FIELDS,
  dogs: DOG_TARGET_FIELDS,
  services: SERVICE_TARGET_FIELDS,
  balances: BALANCE_TARGET_FIELDS,
};

// ---------- Per-source header presets ----------

type PresetMap = Record<string, string[]>;

const CLIENT_PRESETS: Record<string, PresetMap> = {
  generic_csv: {
    display_name: ["name", "display_name", "client name", "full name"],
    account_type: ["type", "account_type", "account type"],
    primary_email: ["email", "email address"],
    primary_phone: ["phone", "phone number", "mobile"],
    external_id: ["id", "external_id", "client id"],
    notes: ["notes", "note", "comments"],
    tags: ["tags", "labels"],
  },
  sweepgo: {
    display_name: ["Client Name", "Customer Name", "Name"],
    account_type: ["Account Type", "Type"],
    primary_email: ["Email", "Email Address"],
    primary_phone: ["Phone", "Mobile", "Phone Number"],
    external_id: ["Client ID", "Customer ID", "ID"],
    notes: ["Notes"],
  },
  // Header names verified against a real Jobber "Clients and properties"
  // export (scratchpad/jobber-real.csv): "J-ID", "Display Name",
  // "Is Company?", "Main Phone #s"/"Mobile Phone #s" (multi-value, ";"
  // separated), "E-mails", "Tags", Service/Billing address columns.
  jobber: {
    display_name: ["Display Name", "Company/Client name", "Client name", "Company Name", "Name"],
    // "Is Company?" carries "true"/"false" — normalizeAccountType maps
    // true/yes/company → commercial.
    account_type: ["Is Company?", "Client type", "Type"],
    primary_email: ["E-mails", "Email", "Primary email"],
    primary_phone: [
      "Main Phone #s",
      "Mobile Phone #s",
      "Text Message Enabled Phone #",
      "Mobile phone number",
      "Phone",
      "Primary phone number",
    ],
    external_id: ["J-ID", "Client ID", "ID"],
    notes: ["Notes"],
    // Jobber Tags hold cadence/segment info ("2nd & 4th Week", "Follow-Up").
    // They go to the client's tags, where they can be filtered, not notes.
    tags: ["Tags"],
    // Service address preferred; Billing is a per-row fallback in
    // mapClientRow (BILLING_FALLBACK_COLUMNS) when Service cells are empty.
    street: ["Service Street 1", "Billing Street 1", "street", "address", "street address"],
    city: ["Service City", "Billing City", "city", "town"],
    region: ["Service State", "Billing State", "region", "state", "province"],
    postal_code: ["Service Zip code", "Billing Zip code", "postal_code", "zip", "zip code", "postcode"],
  },
  housecall_pro: {
    display_name: ["Customer Name", "Name"],
    account_type: ["Type"],
    primary_email: ["Email"],
    primary_phone: ["Phone", "Mobile"],
    external_id: ["Customer ID", "ID"],
    notes: ["Notes"],
  },
  time_to_pet: {
    display_name: ["Client", "Client Name", "Name"],
    account_type: ["Type"],
    primary_email: ["Email"],
    primary_phone: ["Phone", "Mobile"],
    external_id: ["Client ID", "ID"],
    notes: ["Notes"],
  },
  gorilla_desk: {
    display_name: ["Customer", "Name"],
    account_type: ["Type"],
    primary_email: ["Email"],
    primary_phone: ["Phone"],
    external_id: ["Customer ID", "ID"],
    notes: ["Notes"],
  },
  quoteiq_family: {
    display_name: ["Name", "Client Name"],
    account_type: ["Type"],
    primary_email: ["Email"],
    primary_phone: ["Phone"],
    external_id: ["ID"],
    notes: ["Notes"],
  },
};

// Service-address aliases merged into every Clients preset so the address
// columns present in real Sweep&Go / Jobber / Housecall exports auto-map and
// create a property (finding #12).
const CLIENT_ADDRESS_ALIASES: PresetMap = {
  street: ["street", "address", "address_line_1", "address line 1", "street address", "service address", "billing address", "address 1"],
  city: ["city", "town"],
  region: ["region", "state", "province", "state/province"],
  postal_code: ["postal_code", "postal code", "zip", "zip_code", "zip code", "postcode"],
  gate_code: ["gate code", "gate_code", "gate"],
};
for (const key of Object.keys(CLIENT_PRESETS)) {
  CLIENT_PRESETS[key] = { ...CLIENT_ADDRESS_ALIASES, ...CLIENT_PRESETS[key] };
}

/** Guess which CRM a CSV came from by scoring its headers against every
 * source's preset synonyms. Distinctive, CRM-specific headers ("Company/Client
 * name", "Mobile phone number") weigh more than generic ones every export
 * shares ("Email"). Returns null unless one source clearly wins — a wrong
 * guess is worse than asking, so ties and weak signals fall back to the
 * user's manual selection. */
export function detectImportSource(headers: string[]): (typeof IMPORT_SOURCES)[number] | null {
  const hset = new Set(headers.map((h) => h.trim().toLowerCase()));
  const scores: Array<{ source: (typeof IMPORT_SOURCES)[number]; score: number }> = [];
  for (const source of IMPORT_SOURCES) {
    if (source === "generic_csv") continue;
    let score = 0;
    for (const presets of [CLIENT_PRESETS, PROPERTY_PRESETS, DOG_PRESETS]) {
      const preset = presets[source];
      if (!preset) continue;
      for (const synonyms of Object.values(preset)) {
        for (const syn of synonyms) {
          if (hset.has(syn.toLowerCase())) {
            score += syn.length > 10 || /[/#]/.test(syn) ? 3 : syn.includes(" ") ? 2 : 1;
            break;
          }
        }
      }
    }
    scores.push({ source, score });
  }
  scores.sort((a, b) => b.score - a.score);
  const [top, second] = scores;
  if (!top || top.score < 6) return null;
  if (second && top.score - second.score < 2) return null;
  return top.source;
}

const PROPERTY_PRESETS: Record<string, PresetMap> = {
  generic_csv: {
    client_external_id: ["client_id", "customer_id", "client external id", "external_id"],
    label: ["label", "location", "site", "property"],
    street: ["street", "address", "address_line_1", "street address"],
    city: ["city"],
    region: ["region", "province", "region"],
    postal_code: ["postal_code", "zip", "zip_code", "postcode"],
    gate_code: ["gate code", "gate_code", "gate"],
    notes: ["notes", "note", "instructions"],
  },
  sweepgo: {
    client_external_id: ["Client ID", "Customer ID"],
    label: ["Property Name", "Location Name"],
    street: ["Street", "Address"],
    city: ["City"],
    region: ["State", "Province"],
    postal_code: ["Zip", "Postal Code"],
    gate_code: ["Gate Code"],
    notes: ["Notes", "Service Notes"],
  },
  jobber: {
    client_external_id: ["J-ID", "Client ID"],
    label: ["Service Property Name", "Property name"],
    street: ["Service Street 1", "Street 1", "Street"],
    city: ["Service City", "City"],
    region: ["Service State", "Province/State", "State"],
    postal_code: ["Service Zip code", "Postal/Zip Code", "Postal code", "Zip"],
    gate_code: ["Gate Code"],
    notes: ["Property notes", "Notes"],
  },
  housecall_pro: {
    client_external_id: ["Customer ID"],
    label: ["Address Name"],
    street: ["Street", "Address"],
    city: ["City"],
    region: ["State"],
    postal_code: ["Zip"],
    gate_code: ["Gate Code"],
    notes: ["Notes"],
  },
  time_to_pet: {
    client_external_id: ["Client ID"],
    label: ["Location"],
    street: ["Street"],
    city: ["City"],
    region: ["State"],
    postal_code: ["Zip"],
    gate_code: ["Gate Code"],
    notes: ["Notes"],
  },
  gorilla_desk: {
    client_external_id: ["Customer ID"],
    label: ["Location"],
    street: ["Street"],
    city: ["City"],
    region: ["State"],
    postal_code: ["Zip"],
    gate_code: ["Gate Code"],
    notes: ["Notes"],
  },
  quoteiq_family: {
    client_external_id: ["Client ID"],
    label: ["Location"],
    street: ["Street"],
    city: ["City"],
    region: ["State"],
    postal_code: ["Zip"],
    gate_code: ["Gate Code"],
    notes: ["Notes"],
  },
};

const DOG_PRESETS: Record<string, PresetMap> = {
  generic_csv: {
    client_external_id: ["client_id", "customer_id", "external_id"],
    name: ["name", "dog name", "pet name"],
    breed: ["breed"],
    weight_class: ["weight", "weight_class", "weight (lbs)"],
    notes: ["notes", "note"],
  },
  sweepgo: {
    client_external_id: ["Client ID", "Customer ID"],
    name: ["Dog Name", "Pet Name", "Name"],
    breed: ["Breed"],
    weight_class: ["Weight", "Weight (lbs)"],
    notes: ["Notes"],
  },
  jobber: {
    client_external_id: ["Client ID"],
    name: ["Pet name", "Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
  housecall_pro: {
    client_external_id: ["Customer ID"],
    name: ["Pet Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
  time_to_pet: {
    client_external_id: ["Client ID"],
    name: ["Pet Name", "Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
  gorilla_desk: {
    client_external_id: ["Customer ID"],
    name: ["Pet Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
  quoteiq_family: {
    client_external_id: ["Client ID"],
    name: ["Pet Name", "Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
};

// Backward compatibility
export const SOURCE_PRESETS = CLIENT_PRESETS;

// Header names for recurring plans and balances. No real export of Jobber's
// jobs or aged receivables was on hand when these were written, so they are
// synonyms rather than verified headers; the mapping step shows each guess
// and the owner can point any field at a different column.
const SERVICE_PRESETS: Record<string, PresetMap> = {
  generic_csv: {
    client_external_id: ["client_id", "client id", "customer id", "customer_id", "external_id", "id"],
    client_name: ["client_name", "client", "client name", "customer", "customer name", "customer_name", "name"],
    frequency: ["frequency", "recurrence", "repeats", "schedule", "visit frequency"],
    price_per_visit: ["price", "price per visit", "price_per_visit", "rate", "amount", "cost"],
    service_day: ["day", "service day", "service_day", "weekday", "preferred day"],
    start_date: ["start date", "start_date", "start", "started", "first visit"],
    dog_count: ["dogs", "dog count", "number of dogs", "# dogs"],
    billing: ["billing", "billing type", "billing cadence"],
    service: ["service", "service name", "service_name", "plan", "plan name", "product"],
  },
  jobber: {
    client_external_id: ["Client J-ID", "J-ID", "Client ID"],
    client_name: ["Client name", "Client", "Display Name", "Client Name"],
    frequency: ["Visit frequency", "Frequency", "Recurrence", "Schedule", "Repeats", "Title"],
    price_per_visit: ["Visit total", "Total ($)", "Total", "Price", "Rate", "Line item total"],
    service_day: ["Day", "Service day", "Visit day"],
    start_date: ["Start date", "Scheduled start date", "Created date"],
    dog_count: ["Number of dogs", "Dogs"],
    billing: ["Billing frequency", "Billing"],
    // Jobber's line item is the service ("30 Minute Walk"); "Title" is the
    // job's, which the frequency preset reads first when nothing better
    // exists, so it is not repeated here.
    service: ["Service", "Service name", "Line item", "Line item name", "Product / Service", "Product/Service"],
  },
  sweepgo: {
    client_external_id: ["Client ID", "Customer ID"],
    client_name: ["Client Name", "Customer Name", "Name"],
    frequency: ["Frequency", "Cleanup Frequency", "Service Frequency"],
    price_per_visit: ["Price", "Price Per Cleanup", "Rate", "Amount"],
    service_day: ["Service Day", "Day", "Cleanup Day"],
    start_date: ["Start Date", "Created"],
    dog_count: ["Number of Dogs", "Dogs", "Dog Count"],
    billing: ["Billing", "Billing Type"],
    service: ["Service", "Service Name", "Service Type", "Plan"],
  },
};

const BALANCE_PRESETS: Record<string, PresetMap> = {
  generic_csv: {
    client_external_id: ["client_id", "client id", "customer id", "customer_id", "external_id", "id"],
    client_name: ["client_name", "client", "client name", "customer", "customer name", "customer_name", "name"],
    amount: ["balance", "amount", "amount due", "open balance", "outstanding"],
    due_date: ["due date", "due_date", "due", "due on"],
    note: ["note", "notes", "memo", "description"],
  },
  jobber: {
    client_external_id: ["Client J-ID", "J-ID", "Client ID"],
    client_name: ["Client name", "Client", "Display Name"],
    amount: ["Balance", "Balance ($)", "Outstanding", "Amount due", "Total balance"],
    due_date: ["Due date", "Due"],
    note: ["Notes", "Subject"],
  },
  sweepgo: {
    client_external_id: ["Client ID", "Customer ID"],
    client_name: ["Client Name", "Customer Name", "Name"],
    amount: ["Balance", "Open Balance", "Amount Due"],
    due_date: ["Due Date"],
    note: ["Notes", "Memo"],
  },
};

function presetsForEntity(entity: ImportEntity): Record<string, PresetMap> {
  if (entity === "properties") return PROPERTY_PRESETS;
  if (entity === "dogs") return DOG_PRESETS;
  if (entity === "services") return SERVICE_PRESETS;
  if (entity === "balances") return BALANCE_PRESETS;
  return CLIENT_PRESETS;
}

export function autoMap(
  source: string,
  headers: string[],
  entity: ImportEntity = "clients",
): Record<string, string | null> {
  const presets = presetsForEntity(entity);
  const preset = presets[source] ?? presets.generic_csv;
  const fields = TARGET_FIELDS_BY_ENTITY[entity];
  const lc = headers.map((h) => h.toLowerCase().trim());
  const result: Record<string, string | null> = {};
  for (const field of fields) {
    let pick: string | null = null;
    const candidates = preset[field] ?? [];
    for (const c of candidates) {
      const idx = lc.indexOf(c.toLowerCase().trim());
      if (idx !== -1) {
        pick = headers[idx];
        break;
      }
    }
    result[field] = pick;
  }
  return result;
}

// ---------- Row normalization ----------

function normalizeAccountType(v: unknown): "residential" | "commercial" {
  const s = String(v ?? "").toLowerCase().trim();
  // Jobber's "Is Company?" column is a "true"/"false" boolean: company → commercial.
  if (s === "true" || s === "yes" || s === "y" || s === "company") return "commercial";
  if (s === "false" || s === "no" || s === "n") return "residential";
  if (s.startsWith("comm") || s.includes("business") || s.includes("hoa") || s.includes("commercial")) return "commercial";
  return "residential";
}

function normalizePhone(v: string | null): string | null {
  if (!v) return null;
  // Multi-value cells (Jobber "Main Phone #s": "+13136525507;7343416191")
  // → keep the first non-empty number.
  const first = v.split(/[;,/]/).map((p) => p.trim()).find((p) => p.length > 0);
  if (!first) return null;
  const digits = first.replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return first;
}

// Multi-value email cells (Jobber "E-mails" can hold several, ";"/"," separated)
// → first non-empty entry.
function firstEmail(v: string | null): string | null {
  if (!v) return null;
  const first = v.split(/[;,\s]+/).map((p) => p.trim()).find((p) => p.length > 0);
  return first || null;
}

// Case-insensitive lookup across common column-name synonyms in the raw row.
function rawLookup(raw: Record<string, any>, names: string[]): string | null {
  const keys = Object.keys(raw);
  const lc = keys.map((k) => k.toLowerCase().trim());
  for (const n of names) {
    const idx = lc.indexOf(n.toLowerCase().trim());
    if (idx !== -1) {
      const v = raw[keys[idx]];
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (s) return s;
    }
  }
  return null;
}

const FIRST_NAME_COLUMNS = ["First Name", "First name", "first_name", "Given Name"];
const LAST_NAME_COLUMNS = ["Last Name", "Last name", "last_name", "Family Name", "Surname"];
const ADDRESS_2_COLUMNS = ["Service Street 2", "Street 2", "Address Line 2", "address_line_2", "Address 2", "Unit", "Apt", "Suite"];
// Per-row Billing fallbacks (Jobber): when the Service address cells are
// empty on a given row, fall back to that row's Billing columns.
const BILLING_FALLBACK_COLUMNS: Record<string, string[]> = {
  street: ["Billing Street 1", "Billing Street"],
  city: ["Billing City"],
  region: ["Billing State", "Billing Province"],
  postal_code: ["Billing Zip code", "Billing Zip", "Billing Postal code"],
};
const BILLING_ADDRESS_2_COLUMNS = ["Billing Street 2"];

function getStr(raw: Record<string, any>, mapping: Record<string, string | null>, field: string): string | null {
  const src = mapping[field];
  if (!src) return null;
  const v = raw[src];
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// Exported for unit tests (tests/jobber-import.test.ts) — pure row mapper.
export function mapClientRow(raw: Record<string, any>, mapping: Record<string, string | null>) {
  let display_name = getStr(raw, mapping, "display_name");
  if (!display_name) {
    const first = rawLookup(raw, FIRST_NAME_COLUMNS);
    const last = rawLookup(raw, LAST_NAME_COLUMNS);
    const combined = [first, last].filter(Boolean).join(" ").trim();
    if (combined) display_name = combined;
  }
  if (!display_name) return { mapped: null, error: "Missing display_name (or First Name + Last Name)" };
  const email = firstEmail(getStr(raw, mapping, "primary_email"));
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { mapped: null, error: `Invalid email: ${email}` };
  }

  // Service address with per-row Billing fallback (Jobber exports often leave
  // Billing empty and fill Service — or vice versa for billing-only rows).
  let street = getStr(raw, mapping, "street");
  let usedBilling = false;
  if (!street) {
    street = rawLookup(raw, BILLING_FALLBACK_COLUMNS.street);
    usedBilling = !!street;
  }
  if (street) {
    const line2 = rawLookup(raw, usedBilling ? BILLING_ADDRESS_2_COLUMNS : ADDRESS_2_COLUMNS);
    if (line2) street = `${street}, ${line2}`;
  }
  const city =
    getStr(raw, mapping, "city") ?? rawLookup(raw, BILLING_FALLBACK_COLUMNS.city);
  const region =
    getStr(raw, mapping, "region") ?? rawLookup(raw, BILLING_FALLBACK_COLUMNS.region);
  const postal_code =
    getStr(raw, mapping, "postal_code") ?? rawLookup(raw, BILLING_FALLBACK_COLUMNS.postal_code);

  return {
    mapped: {
      display_name,
      account_type: normalizeAccountType(getStr(raw, mapping, "account_type")),
      primary_email: email,
      primary_phone: normalizePhone(getStr(raw, mapping, "primary_phone")),
      external_id: getStr(raw, mapping, "external_id"),
      notes: getStr(raw, mapping, "notes"),
      // Optional inline service address → a property is created on commit.
      street,
      city,
      region,
      postal_code,
      gate_code: getStr(raw, mapping, "gate_code"),
      tags: parseTags(getStr(raw, mapping, "tags")),
    },
    error: null as string | null,
  };
}

function mapPropertyRow(raw: Record<string, any>, mapping: Record<string, string | null>) {
  const client_external_id = getStr(raw, mapping, "client_external_id");
  if (!client_external_id) return { mapped: null, error: "Missing client_external_id (link to client)" };
  let street = getStr(raw, mapping, "street");
  if (!street) return { mapped: null, error: "Missing street" };
  const line2 = rawLookup(raw, ADDRESS_2_COLUMNS);
  if (line2) street = `${street}, ${line2}`;
  return {
    mapped: {
      client_external_id,
      label: getStr(raw, mapping, "label"),
      street,
      city: getStr(raw, mapping, "city"),
      region: getStr(raw, mapping, "region"),
      postal_code: getStr(raw, mapping, "postal_code"),
      gate_code: getStr(raw, mapping, "gate_code"),
      notes: getStr(raw, mapping, "notes"),
    },
    error: null as string | null,
  };
}

function mapDogRow(raw: Record<string, any>, mapping: Record<string, string | null>) {
  const client_external_id = getStr(raw, mapping, "client_external_id");
  if (!client_external_id) return { mapped: null, error: "Missing client_external_id (link to client)" };
  const name = getStr(raw, mapping, "name");
  if (!name) return { mapped: null, error: "Missing dog name" };
  const wRaw = getStr(raw, mapping, "weight_class");
  let weightClass: string | null = null;
  if (wRaw) {
    const n = Number(wRaw.replace(/[^\d.]/g, ""));
    if (!Number.isNaN(n) && n > 0) {
      weightClass = n < 25 ? "small" : n < 60 ? "medium" : "large";
    } else {
      weightClass = wRaw.toLowerCase();
    }
  }
  return {
    mapped: {
      client_external_id,
      name,
      breed: getStr(raw, mapping, "breed"),
      weight_class: weightClass,
      notes: getStr(raw, mapping, "notes"),
    },
    error: null as string | null,
  };
}

function mapRow(entity: ImportEntity, raw: Record<string, any>, mapping: Record<string, string | null>) {
  if (entity === "properties") return mapPropertyRow(raw, mapping);
  if (entity === "dogs") return mapDogRow(raw, mapping);
  if (entity === "services") return mapServiceRow(raw, mapping);
  if (entity === "balances") return mapBalanceRow(raw, mapping);
  return mapClientRow(raw, mapping);
}

// The prefix every imported opening balance's invoice note starts with, so a
// second import of the same file can find and skip what the first created.
const OPENING_BALANCE_NOTE = "Opening balance";

// ---------- Server functions ----------

export const listImportBatches = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data, error } = await supabase
      .from("import_batches")
      .select("id, source, entity, filename, status, stats, error, committed_at, created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { batches: data ?? [] };
  });

export const getImportBatch = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ batchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await resolveOrgId(supabase, context.userId);
    const { data: batch, error: be } = await supabase
      .from("import_batches")
      .select("*")
      .eq("id", data.batchId)
      .single();
    if (be) throw new Error(be.message);
    const { data: rows, error: re } = await supabase
      .from("import_rows")
      .select("id, row_num, raw, mapped, action, target_id, error")
      .eq("batch_id", data.batchId)
      .order("row_num", { ascending: true })
      .limit(2000);
    if (re) throw new Error(re.message);
    return { batch, rows: rows ?? [] };
  });

const previewSchema = z.object({
  source: z.enum(IMPORT_SOURCES),
  entity: z.enum(IMPORT_ENTITIES).default("clients"),
  filename: z.string().optional(),
  mapping: z.record(z.string(), z.string().nullable()),
  rows: z.array(z.record(z.string(), z.any())).min(1).max(5000),
});

export const previewImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => previewSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const entity = data.entity;

    // Load existing rows for dedupe/linking depending on entity
    const { data: existingClients, error: ecErr } = await supabase
      .from("clients")
      .select("id, primary_email, import_external_id, import_source, display_name")
      .eq("organization_id", orgId);
    if (ecErr) throw new Error(ecErr.message);
    const clientByExternal = new Map<string, string>();
    const clientByEmail = new Map<string, string>();
    // By exact name, for exports that carry no id. A name two clients share
    // resolves to nobody: guessing which one owes the balance is worse than
    // refusing the row and saying why.
    const clientByName = new Map<string, string | null>();
    for (const c of existingClients ?? []) {
      if (c.import_external_id && c.import_source === data.source) {
        clientByExternal.set(c.import_external_id, c.id);
      }
      if (c.primary_email) clientByEmail.set(c.primary_email.toLowerCase(), c.id);
      const nm = (c.display_name ?? "").trim().toLowerCase();
      if (nm) clientByName.set(nm, clientByName.has(nm) ? null : c.id);
    }
    const resolveClient = (m: { client_external_id: string | null; client_name: string | null }) => {
      if (m.client_external_id && clientByExternal.has(m.client_external_id)) {
        return { id: clientByExternal.get(m.client_external_id)!, error: null };
      }
      const nm = (m.client_name ?? "").trim().toLowerCase();
      if (nm && clientByName.has(nm)) {
        const id = clientByName.get(nm);
        return id
          ? { id, error: null }
          : { id: null, error: `More than one client is called "${m.client_name}"; add an ID column` };
      }
      return {
        id: null,
        error: `No client ${m.client_external_id ? `with id ${m.client_external_id}` : `called "${m.client_name}"`} (import clients first)`,
      };
    };

    let existingPropertyKeys = new Set<string>();
    let existingDogKeys = new Set<string>();
    // Re-running an import must not double anyone's plan or bill.
    const clientsWithActivePlan = new Set<string>();
    const clientsWithOpeningBalance = new Set<string>();
    if (entity === "services") {
      const { data: subs } = await supabase
        .from("subscriptions")
        .select("client_id")
        .eq("organization_id", orgId)
        .in("status", ["active", "paused"]);
      for (const x of subs ?? []) clientsWithActivePlan.add(x.client_id);
    } else if (entity === "balances") {
      const { data: invs } = await supabase
        .from("invoices")
        .select("client_id")
        .eq("organization_id", orgId)
        .like("notes", `${OPENING_BALANCE_NOTE}%`);
      for (const x of invs ?? []) clientsWithOpeningBalance.add(x.client_id);
    }
    if (entity === "properties") {
      const { data: props } = await supabase
        .from("properties")
        .select("client_id, street, postal_code")
        .eq("organization_id", orgId);
      for (const p of props ?? []) {
        existingPropertyKeys.add(`${p.client_id}::${(p.street ?? "").toLowerCase()}::${p.postal_code ?? ""}`);
      }
    } else if (entity === "dogs") {
      const { data: dogs } = await supabase
        .from("dogs")
        .select("property_id, name, properties!inner(client_id)")
        .eq("organization_id", orgId);
      for (const d of (dogs ?? []) as any[]) {
        const cid = d.properties?.client_id;
        if (cid) existingDogKeys.add(`${cid}::${(d.name ?? "").toLowerCase()}`);
      }
    }

    // Create batch
    const { data: batch, error: bErr } = await supabase
      .from("import_batches")
      .insert({
        organization_id: orgId,
        created_by: userId,
        source: data.source,
        entity,
        filename: data.filename ?? null,
        status: "previewing",
        mapping: data.mapping,
      })
      .select("id")
      .single();
    if (bErr) throw new Error(bErr.message);
    const batchId = batch.id as string;

    const rowsToInsert: any[] = [];
    let create = 0, update = 0, skip = 0, errors = 0;

    data.rows.forEach((raw, idx) => {
      const { mapped, error } = mapRow(entity, raw, data.mapping as any);
      if (error || !mapped) {
        errors += 1;
        rowsToInsert.push({
          batch_id: batchId, organization_id: orgId, row_num: idx + 1,
          raw, mapped: null, action: "error", target_id: null, error,
        });
        return;
      }
      let action: "create" | "update" | "skip" = "create";
      let target_id: string | null = null;

      if (entity === "clients") {
        const m = mapped as any;
        if (m.external_id && clientByExternal.has(m.external_id)) {
          action = "update";
          target_id = clientByExternal.get(m.external_id)!;
        } else if (m.primary_email && clientByEmail.has(m.primary_email.toLowerCase())) {
          action = "skip";
          target_id = clientByEmail.get(m.primary_email.toLowerCase())!;
        }
      } else if (entity === "properties") {
        const m = mapped as any;
        const clientId = clientByExternal.get(m.client_external_id);
        if (!clientId) {
          errors += 1;
          rowsToInsert.push({
            batch_id: batchId, organization_id: orgId, row_num: idx + 1,
            raw, mapped, action: "error", target_id: null,
            error: `No client with external id ${m.client_external_id} (import clients first)`,
          });
          return;
        }
        target_id = clientId;
        const key = `${clientId}::${m.street.toLowerCase()}::${m.postal_code ?? ""}`;
        if (existingPropertyKeys.has(key)) action = "skip";
      } else if (entity === "dogs") {
        const m = mapped as any;
        const clientId = clientByExternal.get(m.client_external_id);
        if (!clientId) {
          errors += 1;
          rowsToInsert.push({
            batch_id: batchId, organization_id: orgId, row_num: idx + 1,
            raw, mapped, action: "error", target_id: null,
            error: `No client with external id ${m.client_external_id} (import clients first)`,
          });
          return;
        }
        target_id = clientId;
        const key = `${clientId}::${m.name.toLowerCase()}`;
        if (existingDogKeys.has(key)) action = "skip";
      } else if (entity === "services" || entity === "balances") {
        const m = mapped as any;
        const who = resolveClient(m);
        if (!who.id) {
          errors += 1;
          rowsToInsert.push({
            batch_id: batchId, organization_id: orgId, row_num: idx + 1,
            raw, mapped, action: "error", target_id: null, error: who.error,
          });
          return;
        }
        target_id = who.id;
        if (entity === "services" && clientsWithActivePlan.has(who.id)) action = "skip";
        if (entity === "balances" && clientsWithOpeningBalance.has(who.id)) action = "skip";
        // Only what is already in the database counts as a repeat. Two rows
        // for one client in the same file are two plans, or two open
        // invoices from an aged-receivables export, and both are kept.
      }

      if (action === "create") create += 1;
      else if (action === "update") update += 1;
      else skip += 1;
      rowsToInsert.push({
        batch_id: batchId, organization_id: orgId, row_num: idx + 1,
        raw, mapped, action, target_id, error: null,
      });
    });

    for (let i = 0; i < rowsToInsert.length; i += 500) {
      const chunk = rowsToInsert.slice(i, i + 500);
      const { error: iErr } = await supabase.from("import_rows").insert(chunk);
      if (iErr) throw new Error(iErr.message);
    }

    const stats = { total: data.rows.length, create, update, skip, errors };
    await supabase.from("import_batches").update({ stats }).eq("id", batchId);

    return { batchId, stats };
  });

export const commitImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ batchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);

    const { data: batch, error: bErr } = await supabase
      .from("import_batches")
      .select("id, status, source, entity, organization_id")
      .eq("id", data.batchId)
      .single();
    if (bErr) throw new Error(bErr.message);
    if (batch.organization_id !== orgId) throw new Error("Forbidden");
    if (batch.status !== "previewing") throw new Error(`Batch is ${batch.status}; cannot commit.`);

    const { data: rows, error: rErr } = await supabase
      .from("import_rows")
      .select("id, mapped, action, target_id")
      .eq("batch_id", data.batchId)
      .in("action", ["create", "update"]);
    if (rErr) throw new Error(rErr.message);

    const entity = (batch.entity ?? "clients") as ImportEntity;

    // Validate the subscription gate ONCE up front instead of letting every
    // "create" row fail individually with the same trigger error (a 311-row
    // import used to fail 311 times with no upfront warning).
    if (entity === "clients") {
      const createCount = (rows ?? []).filter((r) => r.action === "create").length;
      if (createCount > 0) {
        const { data: canAdd, error: gateErr } = await supabase.rpc("org_can_add_client", { _org_id: orgId });
        if (!gateErr && canAdd === false) {
          throw new Error(
            `This import would add ${createCount} new client${createCount === 1 ? "" : "s"}, but your subscription doesn't currently allow adding clients. ` +
            `Reactivate your plan in Settings → Plan & billing, then commit this import again. Nothing has been imported yet.`,
          );
        }
      }
    }

    // An opening balance is an invoice: the same permission a manual invoice
    // needs, checked once rather than per row.
    if (entity === "balances") {
      await requirePermission(supabase, userId, "manage_client_billing");
    }
    let netDays = 15;
    if (entity === "balances") {
      const { data: org } = await supabase
        .from("organizations")
        .select("invoice_net_days")
        .eq("id", orgId)
        .single();
      netDays = org?.invoice_net_days ?? 15;
    }
    const sourceLabel = batch.source === "jobber" ? "Jobber" : batch.source === "sweepgo" ? "Sweep&Go" : "your previous system";

    // The business's services, for a plan row that names one. Read once; a
    // name the business has not got is created on first sight (no price,
    // the line its words suggest) and remembered for the rest of the batch.
    // Creating one needs manage_pricing, as Settings → Services does; an
    // importer without it gets that row refused with a sentence, and the
    // rest of the file still goes in.
    const serviceCatalog: ImportService[] = [];
    let orgLines: ReturnType<typeof serviceLinesOrDefault> = serviceLinesOrDefault(null);
    if (entity === "services") {
      const [{ data: svc, error: svcErr }, { data: orgRow }] = await Promise.all([
        supabase.from("services").select("id, name, service_line").eq("organization_id", orgId),
        supabase.from("organizations").select("service_lines").eq("id", orgId).maybeSingle(),
      ]);
      if (svcErr) throw new Error(svcErr.message);
      serviceCatalog.push(...((svc ?? []) as ImportService[]));
      orgLines = serviceLinesOrDefault(orgRow?.service_lines);
    }
    const resolveImportService = async (name: string | null): Promise<ImportService | null> => {
      const found = matchImportService(name, serviceCatalog);
      if (found !== undefined) return found;
      const draft = newServiceDraft(name!, orgLines);
      const { data: ins, error } = await supabase
        .from("services")
        .insert({ ...draft, organization_id: orgId })
        .select("id, name, service_line")
        .single();
      if (error) {
        if (error.code === "42501") {
          throw new Error(
            `"${draft.name}" is not one of your services yet, and adding services needs the pricing permission. Add it in Settings → Services first, or ask an owner to.`,
          );
        }
        throw new Error(`Could not add the service "${draft.name}": ${error.message}`);
      }
      const made = ins as ImportService;
      serviceCatalog.push(made);
      return made;
    };

    let created = 0, updated = 0, failed = 0;

    // Every new client's service address, geocoded up front in ONE call. With
    // a Geocodio key that is one batch request for the whole import instead
    // of one throttled Nominatim request per row (a 500-row import was 500
    // seconds); without one it is the same 1/s loop as before, just earlier.
    // A row missing from this map -- the batch threw -- is geocoded on its own
    // in the loop below, which is what every row used to do.
    const geoByRow = new Map<string, import("./geocode.server").GeocodeResult>();
    if (entity === "clients") {
      type Where = { street?: string; city?: string; region?: string; postal_code?: string };
      const toGeocode = (rows ?? []).flatMap((r) => {
        const m = (r.mapped ?? {}) as Where;
        return r.action === "create" && m.street && m.city ? [{ id: r.id, m }] : [];
      });
      if (toGeocode.length > 0) {
        try {
          const { geocodeAddresses } = await import("./geocode.server");
          const geos = await geocodeAddresses(
            toGeocode.map(({ m }) => ({
              street: m.street,
              city: m.city,
              region: m.region,
              postal_code: m.postal_code,
            })),
          );
          toGeocode.forEach(({ id }, i) => geoByRow.set(id, geos[i]));
        } catch (ge) {
          console.error(
            "import: batch geocode failed; geocoding row by row",
            (ge as Error).message,
          );
        }
      }
    }

    for (const row of rows ?? []) {
      const m = row.mapped as any;
      try {
        if (entity === "clients") {
          if (row.action === "create") {
            const { data: ins, error: cErr } = await supabase
              .from("clients")
              .insert({
                organization_id: orgId,
                display_name: m.display_name,
                account_type: m.account_type,
                primary_email: m.primary_email,
                primary_phone: m.primary_phone,
                notes: m.notes,
                ...(m.tags?.length ? { tags: m.tags } : {}),
                import_source: batch.source,
                import_external_id: m.external_id,
                import_batch_id: batch.id,
                // Import comms hold: newly-imported clients must not receive
                // automated communications until the org initiates contact
                // (manual send clears it) or office lifts the hold. Only set
                // on CREATE — updates leave an existing client's flag alone.
                comms_paused: true,
              })
              .select("id").single();
            if (cErr) throw cErr;
            await supabase.from("import_rows").update({ target_id: ins.id }).eq("id", row.id);
            // If the Clients row carried a service address, create a property
            // for it (auto-geocoded) so routing/pricing/DNA work downstream —
            // instead of silently dropping the address (finding #12).
            if (m.street && m.city) {
              try {
                const { geocodeAddress } = await import("./geocode.server");
                const geo = geoByRow.has(row.id)
                  ? (geoByRow.get(row.id) ?? null)
                  : await geocodeAddress({
                      street: m.street,
                      city: m.city,
                      region: m.region,
                      postal_code: m.postal_code,
                    });
                const { detectZoneId } = await import("@/lib/properties.functions");
                // Type-appropriate zone matching (B3): the imported property
                // inherits the client's account type, so a commercial client
                // lands in a commercial zone even when a residential zone
                // covers the same ZIP.
                const importAccountType =
                  m.account_type === "commercial" || m.account_type === "residential"
                    ? m.account_type
                    : null;
                const importZoneId = await detectZoneId(supabase, orgId, {
                  postalCode: m.postal_code,
                  point:
                    geo?.latitude != null && geo?.longitude != null
                      ? { lat: geo.latitude, lng: geo.longitude }
                      : null,
                  accountType: importAccountType,
                });
                await supabase.from("properties").insert({
                  organization_id: orgId,
                  client_id: ins.id,
                  street: m.street,
                  city: m.city,
                  region: m.region || null,
                  postal_code: m.postal_code || null,
                  gate_code: m.gate_code || null,
                  account_type: importAccountType,
                  address_source: "manual",
                  auto_zone_id: importZoneId,
                  zone_id: importZoneId,
                  latitude: geo?.latitude ?? null,
                  longitude: geo?.longitude ?? null,
                });
              } catch (pe) {
                // Non-fatal: the client is created; a failed property/geocode
                // shouldn't roll back the client. Logged for follow-up.
                console.error("import: property create/geocode failed", (pe as Error).message);
              }
            }
            created += 1;
          } else if (row.action === "update" && row.target_id) {
            const { error: uErr } = await supabase.from("clients").update({
              display_name: m.display_name,
              account_type: m.account_type,
              primary_email: m.primary_email,
              primary_phone: m.primary_phone,
              notes: m.notes,
              ...(m.tags?.length ? { tags: m.tags } : {}),
            }).eq("id", row.target_id);
            if (uErr) throw uErr;
            updated += 1;
          }
        } else if (entity === "properties") {
          if (row.action === "create" && row.target_id) {
            const { detectZoneId } = await import("@/lib/properties.functions");
            // Type-appropriate zone matching (B3): fall back to the owning
            // client's account type so the property lands in a zone typed for
            // its account (commercial client to commercial zone).
            const { data: ownerClient } = await supabase
              .from("clients")
              .select("account_type")
              .eq("id", row.target_id)
              .maybeSingle();
            const propAccountType =
              ownerClient?.account_type === "commercial" || ownerClient?.account_type === "residential"
                ? ownerClient.account_type
                : null;
            const propZoneId = await detectZoneId(supabase, orgId, {
              postalCode: m.postal_code,
              point: null,
              accountType: propAccountType,
            });
            const { data: ins, error: cErr } = await supabase
              .from("properties")
              .insert({
                organization_id: orgId,
                client_id: row.target_id,
                label: m.label,
                street: m.street,
                city: m.city,
                region: m.region,
                postal_code: m.postal_code,
                gate_code: m.gate_code,
                access_notes: m.notes,
                account_type: propAccountType,
                address_source: "manual",
                auto_zone_id: propZoneId,
                zone_id: propZoneId,
              })
              .select("id").single();
            if (cErr) throw cErr;
            await supabase.from("import_rows").update({ target_id: ins.id }).eq("id", row.id);
            created += 1;
          }
        } else if (entity === "dogs") {
          if (row.action === "create" && row.target_id) {
            // Attach to client's first property
            const { data: prop, error: pErr } = await supabase
              .from("properties")
              .select("id")
              .eq("organization_id", orgId)
              .eq("client_id", row.target_id)
              .order("created_at", { ascending: true })
              .limit(1)
              .maybeSingle();
            if (pErr) throw pErr;
            if (!prop) throw new Error("Client has no property; import a property first");
            const { data: ins, error: cErr } = await supabase
              .from("dogs")
              .insert({
                organization_id: orgId,
                property_id: prop.id,
                name: m.name,
                breed: m.breed,
                weight_class: m.weight_class,
                notes: m.notes,
              })
              .select("id").single();
            if (cErr) throw cErr;
            await supabase.from("import_rows").update({ target_id: ins.id }).eq("id", row.id);
            created += 1;
          }
        } else if (entity === "services") {
          if (row.action === "create" && row.target_id) {
            const { data: client } = await supabase
              .from("clients")
              .select("account_type")
              .eq("id", row.target_id)
              .single();
            const { data: prop } = await supabase
              .from("properties")
              .select("id, zone_id")
              .eq("organization_id", orgId)
              .eq("client_id", row.target_id)
              .order("created_at", { ascending: true })
              .limit(1)
              .maybeSingle();
            if (!prop) throw new Error("Client has no address; import clients with their service address first");
            const isRes = client?.account_type !== "commercial";
            let dogCount: number | null = m.dog_count;
            if (isRes && !dogCount) {
              const { count } = await supabase
                .from("dogs")
                .select("id", { count: "exact", head: true })
                .eq("property_id", prop.id);
              dogCount = Math.max(1, count ?? 1);
            }
            // The service the row names, or none (the database then gives
            // the plan the business's default, as it always has).
            const service = await resolveImportService(m.service_name ?? null);
            const { data: ins, error: sErr } = await supabase
              .from("subscriptions")
              .insert(
                importPlanRow(m, {
                  orgId,
                  clientId: row.target_id,
                  propertyId: prop.id,
                  zoneId: prop.zone_id ?? null,
                  isResidential: isRes,
                  dogCount,
                  service,
                  now: new Date().toISOString(),
                }) as any,
              )
              .select("id")
              .single();
            if (sErr) throw sErr;
            await supabase.from("import_rows").update({ target_id: ins.id }).eq("id", row.id);
            created += 1;
          }
        } else if (entity === "balances") {
          if (row.action === "create" && row.target_id) {
            const nowIso = new Date().toISOString();
            const today = nowIso.slice(0, 10);
            const dueOn = m.due_on ?? new Date(Date.now() + netDays * 86_400_000).toISOString().slice(0, 10);
            const description = `Opening balance carried over from ${sourceLabel}`;
            const { data: inv, error: iErr } = await supabase
              .from("invoices")
              .insert({
                organization_id: orgId,
                client_id: row.target_id,
                kind: "postpaid",
                status: "open",
                // No sales tax, whatever the org's rate: an opening balance is
                // historical, already taxed (or not) in the books it came from.
                // tax_cents and tax_rate_bps default to 0.
                subtotal_cents: m.amount_cents,
                total_cents: m.amount_cents,
                period_start: today,
                period_end: today,
                issued_at: nowIso,
                due_on: dueOn,
                notes: m.note ? `${OPENING_BALANCE_NOTE}: ${m.note}` : OPENING_BALANCE_NOTE,
              })
              .select("id")
              .single();
            if (iErr) throw iErr;
            const { error: lErr } = await supabase
              .from("invoice_line_items")
              .insert({ invoice_id: inv.id, description, amount_cents: m.amount_cents });
            if (lErr) {
              await supabase.from("invoices").delete().eq("id", inv.id);
              throw lErr;
            }
            await supabase.from("import_rows").update({ target_id: inv.id }).eq("id", row.id);
            created += 1;
          }
        }
      } catch (e: any) {
        failed += 1;
        await supabase.from("import_rows").update({
          action: "error",
          error: e?.message ?? String(e),
        }).eq("id", row.id);
      }
    }

    // New plans need their visits now, not at tonight's run. One pass for the
    // whole batch, as onboardClient does for one client.
    if (entity === "services" && created > 0) {
      const { generateVisitHorizon } = await import("@/lib/visit-generation.server");
      await generateVisitHorizon(supabase, orgId);
    }

    const stats = { created, updated, failed };
    await supabase.from("import_batches").update({
      status: failed && !created && !updated ? "failed" : "committed",
      stats,
      committed_at: new Date().toISOString(),
    }).eq("id", data.batchId);

    return stats;
  });

export const cancelImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ batchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await resolveOrgId(supabase, context.userId);
    const { error } = await supabase
      .from("import_batches")
      .update({ status: "cancelled" })
      .eq("id", data.batchId)
      .eq("status", "previewing");
    if (error) throw new Error(error.message);
    return { ok: true };
  });
