import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
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
import {
  ADDRESS_2_COLUMNS,
  BILLING_ADDRESS_2_COLUMNS,
  BILLING_FALLBACK_COLUMNS,
  COMPANY_NAME_COLUMNS,
  extrasSummary,
  FIRST_NAME_COLUMNS,
  joinNotes,
  LAST_NAME_COLUMNS,
  leftoverColumns,
  parseInactive,
  parsePetNames,
  parseYesNo,
  rowExtras,
  UNDO_NEEDS_BILLING,
  undoRefusal,
  type PetName,
  type UndoUsage,
} from "@/lib/import-leftovers";
import { parseMoneyCents } from "@/lib/import-services";
import { newInvoice } from "@/lib/db-insert";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import {
  alreadyInDatabase,
  clientDuplicateIndex,
  commitRefusal,
  dogKey,
  importContentHash,
  importDisplayStatus,
  IMPORT_NOT_FOUND,
  labelClientRows,
  previewStats,
  propertyKey,
  refusalMessage,
  rememberClient,
  retryRefusal,
  type CommitBlock,
  type ExistingClient,
  type ExistingRecords,
} from "@/lib/import-commit-guard";

// Bulk import creates/overwrites client data — every function in this file
// is gated on manage_imports, matching the /imports route boundary.
async function resolveOrgId(supabase: SupabaseClient<Database>, userId: string): Promise<string> {
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
  // Best-guess formats (#857): no sample export is in hand, so their column
  // names below are guesses and the page says so. Every column of such a
  // file is shown before anything is saved.
  "gingr",
  "moego",
] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** What a person calls each source. */
export const IMPORT_SOURCE_LABELS: Record<ImportSource, string> = {
  generic_csv: "Generic CSV",
  sweepgo: "Sweep&Go",
  jobber: "Jobber",
  housecall_pro: "Housecall Pro",
  time_to_pet: "Time To Pet",
  gorilla_desk: "GorillaDesk",
  quoteiq_family: "QuoteIQ / Flowcarve / DoTimely",
  gingr: "Gingr",
  moego: "MoeGo",
};

/** Sources whose column names were VERIFIED against the vendor's own
 *  documentation or sample file. The rest are recognized by best guess:
 *  the mapping is a starting point, and the owner checks every column. */
export const VERIFIED_SOURCES: readonly ImportSource[] = ["jobber", "time_to_pet"];
export const isVerifiedSource = (source: string): boolean =>
  source === "generic_csv" || (VERIFIED_SOURCES as readonly string[]).includes(source);

/** The database's import_source enum, as this file knows it. The generated
 *  types (src/integrations/supabase/types.ts, owned by #870) do not yet
 *  carry gingr and moego, which 20261111050000 adds. */
type DbImportSource = Database["public"]["Enums"]["import_source"];
const asDbSource = (source: ImportSource): DbImportSource => source as DbImportSource;
/** import_batches as 20261111050000 leaves it: the generated Row plus
 *  undone_at, which the types (owned by #870) do not carry yet. */
type ImportBatchRow = Database["public"]["Tables"]["import_batches"]["Row"] & {
  undone_at?: string | null;
};

export const IMPORT_ENTITIES = ["clients", "properties", "dogs", "services", "balances"] as const;

/** Rows written per insert statement during a commit (#617). */
const IMPORT_WRITE_CHUNK = 200;
/** Per-row result updates in flight at once during a commit. */
const IMPORT_ROW_UPDATES_AT_ONCE = 20;
/** The most a commit spends on the 1-a-second geocoder when there is no
 *  Geocodio key. Addresses past it are saved without a pin (#617). */
const IMPORT_GEOCODE_BUDGET_MS = 60_000;
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
  // One native file brings the whole client (#857): an Archived / Status
  // column lands the client inactive; a do-not-text flag turns texts off;
  // pets packed into one cell ("Rex, Bella") become that client's pets; an
  // Account Balance becomes an opening balance, with no second file.
  "archived",
  "do_not_text",
  "pets",
  "balance",
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

// A dog finds its client by the old system's id, or, for an export that has
// none, by the client's email, phone or exact name (#656).
export const DOG_TARGET_FIELDS = [
  "client_external_id",
  "client_email",
  "client_phone",
  "client_name",
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
  // Jobber's Recurring jobs report names the client and their email, and no
  // id; an email tells two clients of one name apart.
  "client_email",
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

// The columns a vendor's own export names, per source. The generic aliases
// below (CLIENT_ADDRESS_ALIASES) are merged into every preset for the mapping
// step; detection scores a source on ITS OWN names only, so the aliases every
// export shares cannot make one vendor look like another.
const CLIENT_PRESETS_OWN: Record<string, PresetMap> = {
  generic_csv: {
    display_name: ["name", "display_name", "client name", "full name"],
    account_type: ["type", "account_type", "account type"],
    primary_email: ["email", "email address"],
    primary_phone: ["phone", "phone number", "mobile"],
    external_id: ["id", "external_id", "client id"],
    notes: ["notes", "note", "comments"],
    tags: ["tags", "labels"],
    archived: ["archived", "inactive", "status", "active", "client status"],
    do_not_text: ["do not text", "do_not_text", "sms opt out", "sms_opt_out", "text opt out", "no texts"],
    pets: ["pets", "pet names", "pet_names", "animals", "dogs", "dog names"],
    balance: ["balance", "account balance", "open balance", "amount due", "outstanding balance"],
  },
  // Sweep&Go documents the export path (Clients > Residential Clients > Client
  // List CSV) but not its column names. These are GUESSES until a real file
  // is in hand; the page says so.
  sweepgo: {
    display_name: ["Client Name", "Customer Name", "Name"],
    account_type: ["Account Type", "Type"],
    primary_email: ["Email", "Email Address"],
    primary_phone: ["Phone", "Mobile", "Phone Number"],
    external_id: ["Client ID", "Customer ID", "ID"],
    notes: ["Notes"],
    pets: ["Dogs", "Dog Names", "Pets"],
  },
  // Two Jobber client-export dialects, both verified (#857):
  //   A. the help-center sample file (jobber-clients-sample-file.csv):
  //      "Client First Name", "Client Full Name (Display Only)", "Client
  //      Email", "Client Main Phone", "Property Street 1", "Client Internal
  //      Notes", "Account Balance", "Archived (True/False)", "Lead Source".
  //   B. a live Clients and properties export (scratchpad/jobber-real.csv):
  //      "J-ID", "Display Name", "Is Company?", "Main Phone #s"/"Mobile Phone
  //      #s" (multi-value, ";" separated), "E-mails", "Tags", Service/Billing
  //      address columns.
  // The owner renames nothing: either dialect maps as is.
  jobber: {
    display_name: [
      "Display Name",
      "Client Full Name (Display Only)",
      "Company/Client name",
      "Client name",
      "Company Name",
      "Name",
    ],
    // "Is Company?" carries "true"/"false" — normalizeAccountType maps
    // true/yes/company → commercial.
    account_type: ["Is Company?", "Client Is Company?", "Client type", "Type"],
    primary_email: ["E-mails", "Client Email", "Email", "Primary email"],
    primary_phone: [
      "Main Phone #s",
      "Client Main Phone",
      "Mobile Phone #s",
      "Client Mobile Phone",
      "Text Message Enabled Phone #",
      "Client SMS Enabled Phone Number",
      "Client Home Phone",
      "Mobile phone number",
      "Phone",
      "Primary phone number",
    ],
    external_id: ["J-ID", "Client ID", "ID"],
    notes: ["Client Internal Notes", "Notes"],
    // Jobber Tags hold cadence/segment info ("2nd & 4th Week", "Follow-Up").
    // They go to the client's tags, where they can be filtered, not notes.
    tags: ["Tags"],
    // Service address preferred; Billing is a per-row fallback in
    // mapClientRow (BILLING_FALLBACK_COLUMNS) when Service cells are empty.
    street: ["Service Street 1", "Property Street 1", "Billing Street 1", "street", "address", "street address"],
    city: ["Service City", "Property City", "Billing City", "city", "town"],
    region: [
      "Service State",
      "Property State/Province",
      "Billing State",
      "Billing State/Province",
      "region",
      "state",
      "province",
    ],
    postal_code: [
      "Service Zip code",
      "Property Zip/Postal Code",
      "Billing Zip code",
      "Billing Zip/Postal Code",
      "postal_code",
      "zip",
      "zip code",
      "postcode",
    ],
    archived: ["Archived", "Archived (True/False)"],
    balance: ["Account Balance"],
  },
  // Housecall Pro documents the path (Customers > Actions > Export) but not
  // the columns. Guesses until a real file is in hand.
  housecall_pro: {
    display_name: ["Customer Name", "Display Name", "Name"],
    account_type: ["Type"],
    primary_email: ["Email"],
    primary_phone: ["Mobile", "Phone", "Home", "Work"],
    external_id: ["Customer ID", "ID"],
    notes: ["Notes"],
  },
  // Time To Pet, verified: the client export's name column is ONE column,
  // "Full Name", with "Address", "City", "State", "Zip Code" (help article
  // "Exporting client data & mapping locations"). The rest of the columns
  // are whichever fields the owner ticks in the export dialog.
  time_to_pet: {
    display_name: ["Full Name", "Client", "Client Name", "Name"],
    account_type: ["Type"],
    primary_email: ["Email", "Email Address"],
    primary_phone: ["Phone", "Phone Number", "Mobile", "Cell Phone", "Mobile Phone"],
    external_id: ["Client ID", "ID"],
    notes: ["Notes", "Client Notes"],
    pets: ["Pets", "Client's Pets", "Pet Names"],
    archived: ["Status", "Inactive", "Active"],
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
  // Gingr: the default View All Owners fields are documented (First Name,
  // Last Name, Address, City, Zip Code, Email, Home phone, Cell Phone,
  // Animals, Referral, Card on File, Last/Next Reservation, Created At,
  // Receives Email/Text). The CSV's exact spelling is not, so this is a best
  // guess at those labels; First + Last Name are combined by the row mapper.
  gingr: {
    display_name: ["Owner Name", "Owner", "Name"],
    primary_email: ["Email"],
    primary_phone: ["Cell Phone", "Home phone", "Home Phone", "Phone"],
    pets: ["Animals", "Pets"],
    notes: ["Notes"],
  },
  // MoeGo: Client & Pets > Options > Export Clients. No column list is
  // published; the list UI shows Client Name, Phone Number and Pets, and the
  // record is searched by first/last/full name, phone, email and pet name.
  // Best guess only.
  moego: {
    display_name: ["Client Name", "Full Name", "Name"],
    primary_email: ["Email"],
    primary_phone: ["Phone Number", "Phone", "Mobile"],
    pets: ["Pets", "Pet Name", "Pet Names"],
    notes: ["Notes", "Client Notes"],
    tags: ["Tags"],
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
  gate_code: ["gate code", "gate_code", "gate", "access code", "key code"],
  // Flags every export may carry, read the same way whoever wrote them.
  archived: ["archived", "inactive", "status", "client status"],
  do_not_text: ["do not text", "do_not_text", "sms opt out", "text opt out", "no texts", "do not sms"],
  pets: ["pets", "pet names", "animals"],
  balance: ["account balance", "balance", "open balance", "amount due"],
};
const CLIENT_PRESETS: Record<string, PresetMap> = {};
for (const key of Object.keys(CLIENT_PRESETS_OWN)) {
  CLIENT_PRESETS[key] = { ...CLIENT_ADDRESS_ALIASES, ...CLIENT_PRESETS_OWN[key] };
}

/** Headers only one vendor writes. A file that carries every header of a
 *  group is that vendor's, whatever else it holds: Jobber's "J-ID", Time To
 *  Pet's "Full Name" beside "Zip Code", Gingr's "Animals" beside "Cell
 *  Phone". A group is matched whole and case-insensitively. */
const SOURCE_SIGNATURES: Partial<Record<ImportSource, string[][]>> = {
  jobber: [
    ["J-ID"],
    ["Client J-ID"],
    ["Client Full Name (Display Only)"],
    ["Client Internal Notes"],
    ["Client Is Company?"],
    // The Recurring jobs report (verified column options, #857).
    ["Schedule start date", "Line items"],
    ["Schedule start date", "Billing type"],
  ],
  time_to_pet: [
    ["Full Name", "Address", "Zip Code"],
    // The Client Keys export.
    ["Key Name/Code"],
    ["Client's Pets"],
  ],
  gingr: [
    ["Animals", "Cell Phone"],
    ["Animals", "Home phone"],
    ["Animals", "Card on File"],
  ],
};

/** Guess which CRM a CSV came from. A vendor's signature headers decide it
 * outright; otherwise its headers are scored against every source's own
 * synonyms (never the aliases every export shares). Distinctive, CRM-specific
 * headers ("Company/Client name", "Mobile phone number") weigh more than
 * generic ones ("Email"). Returns null unless one source clearly wins: a
 * wrong guess is worse than asking, so ties and weak signals fall back to
 * the user's manual selection. */
export function detectImportSource(headers: string[]): ImportSource | null {
  const hset = new Set(headers.map((h) => h.trim().toLowerCase()));
  const signed = (Object.keys(SOURCE_SIGNATURES) as ImportSource[]).filter((source) =>
    SOURCE_SIGNATURES[source]!.some((group) => group.every((h) => hset.has(h.toLowerCase()))),
  );
  if (signed.length === 1) return signed[0];
  if (signed.length > 1) return null;
  const scores: Array<{ source: ImportSource; score: number }> = [];
  for (const source of IMPORT_SOURCES) {
    if (source === "generic_csv") continue;
    let score = 0;
    // A header counts once per source, whichever presets name it: "Email"
    // in the client, dog and plan presets is one piece of evidence.
    const counted = new Set<string>();
    for (const presets of [CLIENT_PRESETS_OWN, PROPERTY_PRESETS, DOG_PRESETS, SERVICE_PRESETS, BALANCE_PRESETS]) {
      const preset = presets[source];
      if (!preset) continue;
      for (const synonyms of Object.values(preset)) {
        for (const syn of synonyms) {
          const key = syn.toLowerCase();
          if (hset.has(key)) {
            if (!counted.has(key)) {
              counted.add(key);
              score += syn.length > 10 || /[/#]/.test(syn) ? 3 : syn.includes(" ") ? 2 : 1;
            }
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
    street: ["Service Street 1", "Property Street 1", "Service street", "Street 1", "Street"],
    city: ["Service City", "Property City", "Service city", "City"],
    region: ["Service State", "Property State/Province", "Service state/province", "Province/State", "State"],
    postal_code: [
      "Service Zip code",
      "Property Zip/Postal Code",
      "Service zip/postal code",
      "Postal/Zip Code",
      "Postal code",
      "Zip",
    ],
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
  // The Client Keys export (verified): Key Name/Code, With (Location),
  // Client's Pets, Address, City, State, Zip. The key is the access code;
  // who holds it is a note on the property.
  time_to_pet: {
    client_external_id: ["Client ID"],
    label: ["Location"],
    street: ["Street", "Address"],
    city: ["City"],
    region: ["State"],
    postal_code: ["Zip", "Zip Code"],
    gate_code: ["Gate Code", "Key Name/Code"],
    notes: ["Notes", "With (Location)"],
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

// How a dogs file names the client it belongs to, when it has no client id.
// "Name" alone is never the client: in a dogs file it is as likely the dog.
const DOG_CLIENT_LINK: PresetMap = {
  client_email: [
    "Client Email",
    "client_email",
    "Customer Email",
    "Owner Email",
    "Email",
    "E-mail",
    "Primary email",
  ],
  client_phone: [
    "Client Phone",
    "client_phone",
    "Customer Phone",
    "Owner Phone",
    "Phone",
    "Mobile",
    "Mobile phone number",
  ],
  client_name: [
    "Client Name",
    "client_name",
    "Customer Name",
    "Owner Name",
    "Client",
    "Customer",
    "Owner",
  ],
};

// The dog's own name: the specific headers first, and "Name" last, so a file
// with both "Name" (the client) and "Dog name" maps the dog to "Dog name".
const DOG_PRESETS: Record<string, PresetMap> = {
  generic_csv: {
    client_external_id: ["client_id", "customer_id", "external_id"],
    ...DOG_CLIENT_LINK,
    name: ["dog name", "dog_name", "pet name", "pet_name", "dog", "pet", "name"],
    breed: ["breed"],
    weight_class: ["weight", "weight_class", "weight (lbs)"],
    notes: ["notes", "note"],
  },
  sweepgo: {
    client_external_id: ["Client ID", "Customer ID"],
    ...DOG_CLIENT_LINK,
    name: ["Dog Name", "Pet Name", "Name"],
    breed: ["Breed"],
    weight_class: ["Weight", "Weight (lbs)"],
    notes: ["Notes"],
  },
  jobber: {
    client_external_id: ["Client ID"],
    ...DOG_CLIENT_LINK,
    name: ["Pet name", "Dog name", "Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
  housecall_pro: {
    client_external_id: ["Customer ID"],
    ...DOG_CLIENT_LINK,
    name: ["Pet Name", "Dog Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
  // The Pet Data export carries the owner's name and email beside the pet's
  // fields the owner ticks (verified as fields, not as header spellings).
  time_to_pet: {
    client_external_id: ["Client ID"],
    ...DOG_CLIENT_LINK,
    name: ["Pet Name", "Pet", "Dog Name", "Name"],
    breed: ["Breed"],
    weight_class: ["Weight", "Weight (lbs)"],
    notes: ["Notes", "Pet Notes"],
  },
  gorilla_desk: {
    client_external_id: ["Customer ID"],
    ...DOG_CLIENT_LINK,
    name: ["Pet Name", "Dog Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
  quoteiq_family: {
    client_external_id: ["Client ID"],
    ...DOG_CLIENT_LINK,
    name: ["Pet Name", "Dog Name", "Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
  // Best guesses (#857): neither vendor publishes its pet export's columns.
  gingr: {
    client_external_id: ["Owner ID", "Customer ID"],
    ...DOG_CLIENT_LINK,
    name: ["Animal", "Animal Name", "Pet Name", "Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes"],
  },
  moego: {
    client_external_id: ["Client ID"],
    ...DOG_CLIENT_LINK,
    name: ["Pet Name", "Pet", "Name"],
    breed: ["Breed"],
    weight_class: ["Weight"],
    notes: ["Notes", "Pet Notes"],
  },
};

// Backward compatibility
export const SOURCE_PRESETS = CLIENT_PRESETS;

// Header names for recurring plans and balances. Jobber's Recurring jobs
// report columns are verified (help article "Recurring jobs report", #857):
// Job #, Job title, Client name, Client email, Client phone number, Service
// street/city/state/province/zip/postal code, Billing street..., Billing
// type, Automatic invoicing, Visits assigned to, Line items, Total ($),
// Completed visits, Number of invoices, Schedule start date, Schedule end
// date, Custom fields. It has NO visit-frequency column: such a plan comes
// in paused with its frequency left for the owner (mapServiceRow). The
// Sweep&Go names and Jobber's balance names are synonyms rather than
// verified headers; the mapping step shows each guess and the owner can
// point any field at a different column.
const SERVICE_PRESETS: Record<string, PresetMap> = {
  generic_csv: {
    client_external_id: ["client_id", "client id", "customer id", "customer_id", "external_id", "id"],
    client_name: ["client_name", "client", "client name", "customer", "customer name", "customer_name", "name"],
    client_email: ["client_email", "client email", "customer email", "email"],
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
    client_email: ["Client email", "Client Email", "E-mails"],
    frequency: ["Visit frequency", "Frequency", "Recurrence", "Schedule", "Repeats", "Title"],
    price_per_visit: ["Visit total", "Total ($)", "Total", "Price", "Rate", "Line item total"],
    service_day: ["Day", "Service day", "Visit day"],
    start_date: ["Start date", "Schedule start date", "Scheduled start date", "Created date"],
    dog_count: ["Number of dogs", "Dogs"],
    billing: ["Billing type", "Billing frequency", "Billing"],
    // Jobber's line item is the service ("30 Minute Walk"); "Title" is the
    // job's, which the frequency preset reads first when nothing better
    // exists, so it is not repeated here.
    service: [
      "Service",
      "Service name",
      "Line items",
      "Line item",
      "Line item name",
      "Product / Service",
      "Product/Service",
    ],
  },
  sweepgo: {
    client_external_id: ["Client ID", "Customer ID"],
    client_name: ["Client Name", "client_name", "Customer Name", "Name"],
    client_email: ["Email", "Client Email"],
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
    amount: ["Account Balance", "Balance", "Balance ($)", "Outstanding", "Amount due", "Total balance"],
    due_date: ["Due date", "Due"],
    note: ["Notes", "Subject"],
  },
  sweepgo: {
    client_external_id: ["Client ID", "Customer ID"],
    client_name: ["Client Name", "client_name", "Customer Name", "Name"],
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

/** Why a phone cell is not a phone number, or null when it is one (or is
 *  empty). The first number of a multi-number cell is the one checked, and an
 *  extension ("x12", "ext. 12") is allowed after it. A whole number is ten
 *  digits, eleven starting with 1, or "+" and a country code (up to 15). */
export function phoneProblem(v: string | null): string | null {
  if (!v) return null;
  const first = v
    .split(/[;,/]/)
    .map((p) => p.trim())
    .find((p) => p.length > 0);
  if (!first) return null;
  const main = first.replace(/\s*(?:x|ext\.?|extension)\s*\d+\s*$/i, "");
  const digits = main.replace(/\D+/g, "");
  const ok =
    digits.length === 10 ||
    (digits.length === 11 && digits.startsWith("1")) ||
    (main.trim().startsWith("+") && digits.length >= 11 && digits.length <= 15);
  return ok
    ? null
    : `Phone "${first}" is not a full phone number (10 digits, or + and the country code)`;
}

const US_ZIP = /^\d{5}(?:-?\d{4})?$/;
const CA_POSTAL = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/i;

/** A ZIP as it is stored, or an error when it is not one. US five-digit and
 *  ZIP+4, and Canadian postal codes ("K1A 0B1"), are accepted. A four-digit
 *  ZIP is a spreadsheet that dropped the leading zero ("2134" is 02134). */
export function normalizePostal(v: string | null): { value: string | null; error: string | null } {
  if (!v) return { value: null, error: null };
  const s = v.trim();
  if (/^\d{4}$/.test(s)) return { value: `0${s}`, error: null };
  if (US_ZIP.test(s)) {
    const d = s.replace(/\D/g, "");
    return { value: d.length === 9 ? `${d.slice(0, 5)}-${d.slice(5)}` : d, error: null };
  }
  if (CA_POSTAL.test(s)) {
    const c = s.replace(/\s+/g, "").toUpperCase();
    return { value: `${c.slice(0, 3)} ${c.slice(3)}`, error: null };
  }
  return {
    value: null,
    error: `ZIP "${s}" is not a ZIP code (5 digits, ZIP+4, or a Canadian postal code)`,
  };
}

/** The last ten digits of a phone, or null when it has fewer. */
function lastTenDigits(v: string | null | undefined): string | null {
  const d = (v ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
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

// The columns the client row mapper reads without a mapping entry (First +
// Last Name, Street 2, the Billing fallback, Company Name) are listed in
// src/lib/import-leftovers.ts, beside the rule that every other column is
// kept rather than dropped.

function getStr(raw: Record<string, any>, mapping: Record<string, string | null>, field: string): string | null {
  const src = mapping[field];
  if (!src) return null;
  const v = raw[src];
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** The client row as the commit writes it. Exported for the tests. */
export type MappedClient = {
  display_name: string;
  account_type: "residential" | "commercial";
  primary_email: string | null;
  primary_phone: string | null;
  external_id: string | null;
  notes: string | null;
  street: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  gate_code: string | null;
  tags: string[] | null;
  /** The company's name, when the file carries one beside the person's. */
  company: string | null;
  /** False when the file's Archived / Status column says the client is
   *  no longer active; they come in inactive, with messaging off. */
  active: boolean;
  /** True when the file says not to text them. Stored, never acted on. */
  do_not_text: boolean;
  /** Pets named on the client's own row ("Rex, Bella"), each made a pet of
   *  the client on commit when the row has an address to put them on. */
  pets: PetName[] | null;
  /** An amount owed on the client's own row (Jobber's Account Balance), in
   *  cents; an opening balance is written for it on commit. A credit (a
   *  negative balance) goes in the notes instead. */
  balance_cents: number | null;
  /** The columns no field consumed, as the file spelled them. Filled by the
   *  preview, which knows the whole file's headers. */
  extras?: Record<string, string> | null;
};

const squashAddress = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Exported for unit tests (tests/jobber-import.test.ts) — pure row mapper.
export function mapClientRow(
  raw: Record<string, any>,
  mapping: Record<string, string | null>,
): { mapped: MappedClient | null; error: string | null } {
  let display_name = getStr(raw, mapping, "display_name");
  const company = rawLookup(raw, COMPANY_NAME_COLUMNS);
  if (!display_name) {
    const first = rawLookup(raw, FIRST_NAME_COLUMNS);
    const last = rawLookup(raw, LAST_NAME_COLUMNS);
    const combined = [first, last].filter(Boolean).join(" ").trim();
    if (combined) display_name = combined;
  }
  // A company row with no person's name is the company.
  if (!display_name && company) display_name = company;
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
  const postal = normalizePostal(
    getStr(raw, mapping, "postal_code") ?? rawLookup(raw, BILLING_FALLBACK_COLUMNS.postal_code),
  );
  if (postal.error) return { mapped: null, error: postal.error };
  const postal_code = postal.value;
  const phoneRaw = getStr(raw, mapping, "primary_phone");
  const badPhone = phoneProblem(phoneRaw);
  if (badPhone) return { mapped: null, error: badPhone };

  // A billing address that differs from the service address is one service
  // property and a note (product default, #857), not a second property.
  let billingNote: string | null = null;
  if (street && !usedBilling) {
    const bStreet = rawLookup(raw, BILLING_FALLBACK_COLUMNS.street);
    if (bStreet && squashAddress(bStreet) !== squashAddress(getStr(raw, mapping, "street"))) {
      const b2 = rawLookup(raw, BILLING_ADDRESS_2_COLUMNS);
      const billing = [
        b2 ? `${bStreet}, ${b2}` : bStreet,
        rawLookup(raw, BILLING_FALLBACK_COLUMNS.city),
        rawLookup(raw, BILLING_FALLBACK_COLUMNS.region),
        rawLookup(raw, BILLING_FALLBACK_COLUMNS.postal_code),
      ]
        .filter(Boolean)
        .join(", ");
      billingNote = `Billing address: ${billing}`;
    }
  }

  const archivedText = getStr(raw, mapping, "archived");
  const inactive = parseInactive(mapping.archived ?? null, archivedText) ?? false;
  const balanceText = getStr(raw, mapping, "balance");
  let balance_cents: number | null = null;
  let balanceNote: string | null = null;
  if (balanceText) {
    const cents = parseMoneyCents(balanceText);
    if (cents == null) return { mapped: null, error: `Balance not understood: "${balanceText}"` };
    if (cents > 0) balance_cents = cents;
    else if (cents < 0) {
      // A credit is a different conversation (the credit ledger); it is
      // kept where the office will see it rather than turned into a bill.
      balanceNote = `Credit balance of $${(-cents / 100).toFixed(2)} in the old system; add it as account credit.`;
    }
  }
  const pets = parsePetNames(getStr(raw, mapping, "pets"));
  // Pets need an address to live on. Without one they are still kept.
  const petsNote =
    pets.length && !(street && city)
      ? `Pets: ${pets.map((p) => (p.breed ? `${p.name} (${p.breed})` : p.name)).join(", ")} (no address in the file, so they were not added as pets)`
      : null;

  return {
    mapped: {
      display_name,
      account_type: normalizeAccountType(getStr(raw, mapping, "account_type")),
      primary_email: email,
      primary_phone: normalizePhone(phoneRaw),
      external_id: getStr(raw, mapping, "external_id"),
      notes: joinNotes(getStr(raw, mapping, "notes"), billingNote, balanceNote, petsNote),
      // Optional inline service address → a property is created on commit.
      street,
      city,
      region,
      postal_code,
      gate_code: getStr(raw, mapping, "gate_code"),
      tags: parseTags(getStr(raw, mapping, "tags")),
      company: company && company !== display_name ? company : null,
      active: !inactive,
      do_not_text: parseYesNo(getStr(raw, mapping, "do_not_text")) === true,
      pets: pets.length && street && city ? pets : null,
      balance_cents,
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
  const postal = normalizePostal(getStr(raw, mapping, "postal_code"));
  if (postal.error) return { mapped: null, error: postal.error };
  return {
    mapped: {
      client_external_id,
      label: getStr(raw, mapping, "label"),
      street,
      city: getStr(raw, mapping, "city"),
      region: getStr(raw, mapping, "region"),
      postal_code: postal.value,
      gate_code: getStr(raw, mapping, "gate_code"),
      notes: getStr(raw, mapping, "notes"),
    },
    error: null as string | null,
  };
}

export function mapDogRow(raw: Record<string, any>, mapping: Record<string, string | null>) {
  const client_external_id = getStr(raw, mapping, "client_external_id");
  const client_email = firstEmail(getStr(raw, mapping, "client_email"))?.toLowerCase() ?? null;
  const client_phone = getStr(raw, mapping, "client_phone");
  const client_name = getStr(raw, mapping, "client_name");
  if (!client_external_id && !client_email && !client_phone && !client_name) {
    return {
      mapped: null,
      error: "Missing the client: their ID in your old system, email, phone or name",
    };
  }
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
      client_email,
      client_phone,
      client_name,
      name,
      breed: getStr(raw, mapping, "breed"),
      weight_class: weightClass,
      notes: getStr(raw, mapping, "notes"),
    },
    error: null as string | null,
  };
}

function mapRow(
  entity: ImportEntity,
  raw: Record<string, any>,
  mapping: Record<string, string | null>,
  tz: string | null,
) {
  if (entity === "properties") return mapPropertyRow(raw, mapping);
  if (entity === "dogs") return mapDogRow(raw, mapping);
  if (entity === "services") return mapServiceRow(raw, mapping, tz);
  if (entity === "balances") return mapBalanceRow(raw, mapping, tz);
  return mapClientRow(raw, mapping);
}

// The prefix every imported opening balance's invoice note starts with, so a
// second import of the same file can find and skip what the first created.
const OPENING_BALANCE_NOTE = "Opening balance";

// Every page of a select. PostgREST answers at most 1000 rows a request, and a
// duplicate check that saw only the first thousand clients would wave the
// rest through as new.
async function selectAll<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

/** What the business already has, for the entity being imported. Read by the
 *  preview to label rows, and again by the commit, because a preview can be
 *  hours old and the clients it was checked against are not the clients now. */
async function loadExisting(
  supabase: SupabaseClient<Database>,
  orgId: string,
  entity: ImportEntity,
  source: string,
) {
  const clients = await selectAll<ExistingClient>((a, b) =>
    supabase
      .from("clients")
      .select("id, display_name, primary_email, primary_phone, import_source, import_external_id")
      .eq("organization_id", orgId)
      .order("id")
      .range(a, b),
  );
  const records: ExistingRecords = {
    clients: clientDuplicateIndex([], source),
    propertyKeys: new Set(),
    dogKeys: new Set(),
    clientsWithActivePlan: new Set(),
    clientsWithOpeningBalance: new Set(),
  };
  if (entity === "clients" || entity === "properties") {
    const props = await selectAll<{
      client_id: string;
      street: string | null;
      postal_code: string | null;
    }>((a, b) =>
      supabase
        .from("properties")
        .select("client_id, street, postal_code")
        .eq("organization_id", orgId)
        .order("id")
        .range(a, b),
    );
    const streets = new Map<string, { street: string | null; postal_code: string | null }[]>();
    for (const p of props) {
      records.propertyKeys.add(propertyKey(p.client_id, p.street, p.postal_code));
      streets.set(p.client_id, [...(streets.get(p.client_id) ?? []), p]);
    }
    for (const c of clients) c.streets = streets.get(c.id) ?? [];
  }
  records.clients = clientDuplicateIndex(clients, source);
  if (entity === "services") {
    const subs = await selectAll<{ client_id: string }>((a, b) =>
      supabase
        .from("subscriptions")
        .select("client_id")
        .eq("organization_id", orgId)
        .in("status", ["active", "paused"])
        .order("id")
        .range(a, b),
    );
    for (const x of subs) records.clientsWithActivePlan.add(x.client_id);
  } else if (entity === "balances") {
    const invs = await selectAll<{ client_id: string }>((a, b) =>
      supabase
        .from("invoices")
        .select("client_id")
        .eq("organization_id", orgId)
        .like("notes", `${OPENING_BALANCE_NOTE}%`)
        .order("id")
        .range(a, b),
    );
    for (const x of invs) records.clientsWithOpeningBalance.add(x.client_id);
  } else if (entity === "dogs") {
    const dogs = await selectAll<{ name: string; properties: { client_id: string } }>((a, b) =>
      supabase
        .from("dogs")
        .select("name, properties!inner(client_id)")
        .eq("organization_id", orgId)
        .order("id")
        .range(a, b),
    );
    for (const d of dogs) {
      const cid = d.properties?.client_id;
      if (cid) records.dogKeys.add(dogKey(cid, d.name));
    }
  }
  return { clients, records };
}

type TwinCandidate = {
  id: string;
  status: string;
  entity: string;
  filename: string | null;
  content_hash: string | null;
  commit_started_at: string | null;
  committed_at: string | null;
  created_at: string;
};

/** The hash of a stored batch's rows, for batches from before content_hash. */
async function storedRowsHash(
  supabase: SupabaseClient<Database>,
  batchId: string,
  entity: string,
): Promise<string> {
  const rows = await selectAll<{ raw: unknown }>((a, b) =>
    supabase.from("import_rows").select("raw").eq("batch_id", batchId).order("row_num").range(a, b),
  );
  return importContentHash(
    entity,
    rows.map((r) => r.raw),
  );
}

/**
 * Another batch of this business that already committed (or is committing)
 * the same file, or null. By content_hash first; a batch from before the
 * column existed is matched on filename, entity and row count, and then on
 * its stored rows hashed the same way.
 */
async function findCommittedTwin(
  supabase: SupabaseClient<Database>,
  orgId: string,
  batch: TwinCandidate & { total: number },
): Promise<TwinCandidate | null> {
  const cols =
    "id, status, entity, filename, content_hash, commit_started_at, committed_at, created_at";
  const hash = batch.content_hash ?? (await storedRowsHash(supabase, batch.id, batch.entity));
  const { data: same, error } = await supabase
    .from("import_batches")
    .select(cols)
    .eq("organization_id", orgId)
    .eq("content_hash", hash)
    .neq("id", batch.id)
    .not("commit_started_at", "is", null)
    // An undone batch no longer counts as having imported the file (#857).
    .is("undone_at", null)
    .limit(1);
  if (error) throw new Error(error.message);
  if (same?.length) return same[0];

  const filename = batch.filename;
  if (!filename) return null;
  const legacy = await selectAll<TwinCandidate>((from, to) =>
    supabase
      .from("import_batches")
      .select(cols)
      .eq("organization_id", orgId)
      .eq("entity", batch.entity)
      .eq("filename", filename)
      .eq("status", "committed")
      .is("content_hash", null)
      .is("undone_at", null)
      .neq("id", batch.id)
      .order("id")
      .range(from, to),
  );
  for (const old of legacy ?? []) {
    const { count } = await supabase
      .from("import_rows")
      .select("id", { count: "exact", head: true })
      .eq("batch_id", old.id);
    if (count !== batch.total) continue;
    if ((await storedRowsHash(supabase, old.id, old.entity)) === hash) return old;
  }
  return null;
}

/** Close a preview because `twinId` committed the same file. Only a preview
 *  nobody has started committing is changed. */
async function markSuperseded(supabase: SupabaseClient<Database>, batchId: string, twinId: string) {
  const { error } = await supabase
    .from("import_batches")
    .update({ status: "cancelled", superseded_by: twinId })
    .eq("id", batchId)
    .eq("status", "previewing")
    .is("commit_started_at", null);
  if (error) throw new Error(error.message);
}

// ---------- Server functions ----------

export const listImportBatches = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    // Read as the generated Row (#870 has not got undone_at yet): every
    // column, so the one the types lack is still on each batch.
    const { data: batches, error } = await supabase
      .from("import_batches")
      .select("*")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(50);
    const data = batches as ImportBatchRow[] | null;
    if (error) throw new Error(error.message);
    // "committing", "superseded" and "undone" are spelled with columns, not
    // statuses.
    return {
      batches: (data ?? []).map((b) => ({ ...b, status: importDisplayStatus(b) })),
    };
  });

export const getImportBatch = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ batchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const orgId = await resolveOrgId(supabase, context.userId);
    const { data: batchRow, error: be } = await supabase
      .from("import_batches")
      .select("*")
      .eq("id", data.batchId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (be) throw new Error(be.message);
    const batch = batchRow as ImportBatchRow | null;
    // A deleted batch, or one from another business, is an answer rather than
    // an error (#434). `.single()` threw here, the query retried and the page
    // said "Loading…" for good.
    if (!batch) return { batch: null, rows: [], commitBlock: null, retryBlock: null };
    // Why Commit is not offered, when it is not: the same checks commitImport
    // makes, so the page never shows a button the server would refuse.
    let commitBlock: CommitBlock | null = null;
    const refusal = commitRefusal(batch);
    if (refusal) {
      commitBlock = {
        reason: refusal,
        committedBatchId: batch.superseded_by ?? null,
        committedAt: null,
      };
    } else {
      const twin = await findCommittedTwin(supabase, orgId, {
        ...batch,
        total: Number((batch.stats as { total?: number } | null)?.total ?? 0),
      });
      if (twin)
        commitBlock = {
          reason: "superseded",
          committedBatchId: twin.id,
          committedAt: twin.committed_at,
        };
    }
    if (commitBlock?.committedBatchId && !commitBlock.committedAt) {
      const { data: twin } = await supabase
        .from("import_batches")
        .select("committed_at")
        .eq("id", commitBlock.committedBatchId)
        .maybeSingle();
      commitBlock.committedAt = twin?.committed_at ?? null;
    }
    const { data: rows, error: re } = await supabase
      .from("import_rows")
      .select("id, row_num, raw, mapped, action, target_id, error")
      .eq("batch_id", data.batchId)
      .order("row_num", { ascending: true })
      .limit(2000);
    if (re) throw new Error(re.message);
    // Whether "Try again" is offered, and if not, why (#569).
    let retryBlock: string | null = null;
    if (importDisplayStatus(batch) === "failed") {
      let wroteClients = false;
      if ((batch.entity ?? "clients") === "clients") {
        const { count } = await supabase
          .from("clients")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .eq("import_batch_id", batch.id);
        wroteClients = (count ?? 0) > 0;
      }
      retryBlock = retryRefusal(batch, wroteClients);
    }
    // Whether "Undo" is offered, and if not, why (#857): the same check
    // undoImport makes, so the page never shows a button the server refuses.
    let undoBlock: string | null = null;
    if (batch.committed_at && !batch.undone_at) {
      const usage = await importUsage(supabase, orgId, batch);
      undoBlock = undoRefusal(batch, usage);
      // Deleting invoices is a billing act: a caller without the permission
      // is told here rather than offered a button the function refuses.
      if (!undoBlock && usage.invoices) {
        try {
          await requirePermission(supabase, context.userId, "manage_client_billing");
        } catch {
          undoBlock = UNDO_NEEDS_BILLING;
        }
      }
    }
    return {
      batch: { ...batch, status: importDisplayStatus(batch) },
      rows: rows ?? [],
      commitBlock,
      retryBlock,
      undoBlock,
    };
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

    // What already exists, for labelling rows create / update / skip. The
    // commit reads it again (loadExisting), so a stale label cannot create.
    const { clients: existingClients, records: existing } = await loadExisting(
      supabase,
      orgId,
      entity,
      data.source,
    );
    const clientByExternal = existing.clients.byExternal;
    // By exact name, for exports that carry no id. A name two clients share
    // resolves to nobody: guessing which one owes the balance is worse than
    // refusing the row and saying why. An email, when the file has one
    // (Jobber's Recurring jobs report), is tried before the name.
    const clientByName = new Map<string, string | null>();
    const clientByEmail = new Map<string, string | null>();
    for (const c of existingClients) {
      const nm = (c.display_name ?? "").trim().toLowerCase();
      if (nm) clientByName.set(nm, clientByName.has(nm) ? null : c.id);
      const email = (c.primary_email ?? "").trim().toLowerCase();
      if (email) clientByEmail.set(email, clientByEmail.has(email) ? null : c.id);
    }
    const resolveClient = (m: {
      client_external_id: string | null;
      client_name: string | null;
      client_email?: string | null;
    }) => {
      if (m.client_external_id && clientByExternal.has(m.client_external_id)) {
        return { id: clientByExternal.get(m.client_external_id)!, error: null };
      }
      const email = (m.client_email ?? "").trim().toLowerCase();
      if (email && clientByEmail.has(email)) {
        const id = clientByEmail.get(email);
        if (id) return { id, error: null };
        if (!m.client_name)
          return { id: null, error: `More than one client has the email ${email}; add an ID column` };
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
        error: `No client ${
          m.client_external_id
            ? `with id ${m.client_external_id}`
            : m.client_name
              ? `called "${m.client_name}"`
              : `with email ${m.client_email}`
        } (import clients first)`,
      };
    };

    // The business's clock, for a date column that carries a time (#857).
    let tz: string | null = null;
    if (entity === "services" || entity === "balances") {
      const { data: org } = await supabase
        .from("organizations")
        .select("timezone")
        .eq("id", orgId)
        .maybeSingle();
      tz = org?.timezone ?? null;
    }
    // Every column the mapping does not consume is kept, not dropped (#857):
    // its values ride on each row as `extras`, shown on the preview and
    // written on commit (src/lib/import-leftovers.ts).
    const headers = [...new Set(data.rows.flatMap((r) => Object.keys(r)))];
    const leftovers = leftoverColumns(entity, data.mapping, headers);

    // Create batch
    const { data: batch, error: bErr } = await supabase
      .from("import_batches")
      .insert({
        organization_id: orgId,
        created_by: userId,
        source: asDbSource(data.source),
        entity,
        filename: data.filename ?? null,
        status: "previewing",
        mapping: data.mapping,
        content_hash: await importContentHash(entity, data.rows),
      })
      .select("id")
      .single();
    if (bErr) throw new Error(bErr.message);
    const batchId = batch.id as string;

    // A dog's client: the old system's id, then the client's email, phone,
    // and exact name (#656). Dogs used to need the id, so an export without
    // one could not bring its dogs at all. An email or phone two clients
    // share resolves to nobody, as a shared name does: the dog is refused
    // with a reason rather than given to whichever client was read last.
    const clientByPhone = new Map<string, string | null>();
    if (entity === "dogs") {
      for (const c of existingClients) {
        const phone = lastTenDigits(c.primary_phone);
        if (phone) clientByPhone.set(phone, clientByPhone.has(phone) ? null : c.id);
      }
    }
    const resolveDogClient = (m: {
      client_external_id: string | null;
      client_email: string | null;
      client_phone: string | null;
      client_name: string | null;
    }) => {
      if (m.client_external_id && clientByExternal.has(m.client_external_id)) {
        return { id: clientByExternal.get(m.client_external_id)!, error: null };
      }
      const email = (m.client_email ?? "").trim().toLowerCase();
      if (email && clientByEmail.has(email)) {
        const id = clientByEmail.get(email);
        return id
          ? { id, error: null }
          : { id: null, error: `More than one client has the email ${email}; add an ID column` };
      }
      const phone = lastTenDigits(m.client_phone);
      if (phone && clientByPhone.has(phone)) {
        const id = clientByPhone.get(phone);
        return id
          ? { id, error: null }
          : {
              id: null,
              error: `More than one client has the phone ${m.client_phone}; add an ID column`,
            };
      }
      if (m.client_name) {
        return resolveClient({ client_external_id: null, client_name: m.client_name });
      }
      const said = m.client_external_id
        ? `with id ${m.client_external_id}`
        : m.client_email
          ? `with email ${m.client_email}`
          : `with phone ${m.client_phone}`;
      return { id: null, error: `No client ${said} (import clients first)` };
    };

    const mappedRows = data.rows.map((raw) => {
      const out = mapRow(entity, raw, data.mapping as any, tz);
      if (out.mapped) (out.mapped as { extras?: unknown }).extras = rowExtras(raw, leftovers);
      return out;
    });
    // Clients are labelled create or skip the way the commit will treat them:
    // against the clients the business has, and against the rows above in the
    // same file (#656). The commit always skipped a second row with the same
    // email; the preview used to promise it as a create.
    const clientLabels =
      entity === "clients"
        ? labelClientRows(
            mappedRows.map(({ mapped, error }) => {
              const m = mapped as any;
              if (error || !m) return null;
              if (m.external_id && clientByExternal.has(m.external_id)) return null;
              return m;
            }),
            existing.clients,
            data.source,
          )
        : [];

    const rowsToInsert: any[] = [];
    let create = 0, update = 0, skip = 0, errors = 0;

    data.rows.forEach((raw, idx) => {
      const { mapped, error } = mappedRows[idx];
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
      let reason: string | null = null;

      if (entity === "clients") {
        const m = mapped as any;
        const label = clientLabels[idx];
        if (!label) {
          action = "update";
          target_id = clientByExternal.get(m.external_id)!;
        } else {
          // Email, phone, or the same name at the same service address, in
          // the business's clients or earlier in this file.
          action = label.action;
          target_id = label.targetId;
          reason = label.reason;
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
        if (alreadyInDatabase(entity, m, clientId, existing)) action = "skip";
      } else if (entity === "dogs") {
        const m = mapped as any;
        const who = resolveDogClient(m);
        if (!who.id) {
          errors += 1;
          rowsToInsert.push({
            batch_id: batchId, organization_id: orgId, row_num: idx + 1,
            raw, mapped, action: "error", target_id: null, error: who.error,
          });
          return;
        }
        const clientId = who.id;
        target_id = clientId;
        if (alreadyInDatabase(entity, m, clientId, existing)) action = "skip";
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
        if (alreadyInDatabase(entity, m, who.id, existing)) action = "skip";
        // Only what is already in the database counts as a repeat. Two rows
        // for one client in the same file are two plans, or two open
        // invoices from an aged-receivables export, and both are kept.
      }

      if (action === "create") create += 1;
      else if (action === "update") update += 1;
      else skip += 1;
      rowsToInsert.push({
        batch_id: batchId, organization_id: orgId, row_num: idx + 1,
        // A skipped row carries why in `error`; its action says it is not one.
        raw, mapped, action, target_id, error: reason,
      });
    });

    for (let i = 0; i < rowsToInsert.length; i += 500) {
      const chunk = rowsToInsert.slice(i, i + 500);
      const { error: iErr } = await supabase.from("import_rows").insert(chunk);
      if (iErr) throw new Error(iErr.message);
    }

    const stats = { total: data.rows.length, create, update, skip, errors };
    await supabase.from("import_batches").update({ stats }).eq("id", batchId);
    const { data: preview, error: previewError } = await supabase
      .from("import_batches")
      .select("*")
      .eq("id", batchId)
      .single();
    if (previewError) throw new Error(previewError.message);
    if (!preview) throw new Error("Import preview was not found.");
    const twin = await findCommittedTwin(supabase, orgId, { ...preview, total: data.rows.length });
    if (twin) await markSuperseded(supabase, batchId, twin.id);

    return { batchId, stats };
  });

/** Marks a row that failed at commit, keeping what it was going to do so
 *  "Try again" can put it back (#569). Until the column that holds that is
 *  live, the row is still marked, as it always was. */
async function markRowFailed(
  supabase: SupabaseClient<Database>,
  rowId: string,
  action: string,
  message: string,
) {
  const { error } = await supabase
    .from("import_rows")
    .update({
      action: "error",
      error: message,
      commit_failed_action: action as "create" | "update",
    })
    .eq("id", rowId);
  if (error) {
    await supabase.from("import_rows").update({ action: "error", error: message }).eq("id", rowId);
  }
}

/** The reason given most often. */
function mostCommon(reasons: Map<string, number>): string | null {
  let top: string | null = null;
  for (const [reason, n] of reasons) if (!top || n > reasons.get(top)!) top = reason;
  return top;
}

/** A commit that threw: the batch is closed as failed with the reason and
 *  what it had written so far. Only a batch still mid-commit is touched, so a
 *  failure after the batch was marked committed does not undo that. */
async function recordCommitFailure(
  supabase: SupabaseClient<Database>,
  batchId: string,
  preview: unknown,
  counts: { created: number; updated: number; failed: number; skipped: number },
  e: unknown,
) {
  const message = (e as Error)?.message || "The import stopped with an error.";
  const { error } = await supabase
    .from("import_batches")
    .update({
      status: "failed",
      error: message,
      stats: { ...previewStats(preview), ...counts },
      committed_at: new Date().toISOString(),
    })
    .eq("id", batchId)
    .eq("status", "previewing");
  if (error) console.error("import: could not record a failed commit", error.message);
}

export const commitImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ batchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);

    const { data: batch, error: bErr } = await supabase
      .from("import_batches")
      .select("*")
      .eq("id", data.batchId)
      .maybeSingle();
    if (bErr) throw new Error(bErr.message);
    if (!batch || batch.organization_id !== orgId) throw new Error(IMPORT_NOT_FOUND);
    const refusal = commitRefusal(batch);
    if (refusal) throw new Error(refusalMessage(refusal));
    const twin = await findCommittedTwin(supabase, orgId, {
      ...batch,
      total: Number((batch.stats as { total?: number } | null)?.total ?? 0),
    });
    if (twin) {
      await markSuperseded(supabase, batch.id, twin.id);
      throw new Error(refusalMessage("superseded"));
    }

    const rows = await selectAll<
      Pick<
        Database["public"]["Tables"]["import_rows"]["Row"],
        "id" | "mapped" | "action" | "target_id"
      >
    >((from, to) =>
      supabase
        .from("import_rows")
        .select("id, mapped, action, target_id")
        .eq("batch_id", data.batchId)
        .in("action", ["create", "update"])
        .order("row_num")
        .range(from, to),
    );

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
    // needs, checked once rather than per row. A clients file carries one
    // when it has an Account Balance column (Jobber's does, #857).
    const writesBalances =
      entity === "balances" ||
      (entity === "clients" &&
        rows.some((r) => r.action === "create" && ((r.mapped as MappedClient | null)?.balance_cents ?? 0) > 0));
    if (writesBalances) {
      await requirePermission(supabase, userId, "manage_client_billing");
    }
    let netDays = 15;
    if (writesBalances) {
      const { data: org } = await supabase
        .from("organizations")
        .select("invoice_net_days")
        .eq("id", orgId)
        .single();
      netDays = org?.invoice_net_days ?? 15;
    }
    // Claim before any writes or geocoding. A second request gets no row;
    // another batch of this file collides with the unique file index.
    const contentHash = batch.content_hash ?? (await storedRowsHash(supabase, batch.id, entity));
    const { data: claimed, error: claimError } = await supabase
      .from("import_batches")
      .update({ commit_started_at: new Date().toISOString(), content_hash: contentHash })
      .eq("id", batch.id)
      .eq("organization_id", orgId)
      .eq("status", "previewing")
      .is("commit_started_at", null)
      .is("superseded_by", null)
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .select("id")
      .maybeSingle();
    if (claimError) {
      if (claimError.code === "23505") {
        const winner = await findCommittedTwin(supabase, orgId, {
          ...batch,
          content_hash: contentHash,
          total: rows.length,
        });
        if (winner) await markSuperseded(supabase, batch.id, winner.id);
        throw new Error(refusalMessage("superseded"));
      }
      throw new Error(claimError.message);
    }
    if (!claimed)
      throw new Error("This preview can no longer commit. Refresh to see its current status.");
    // The rows the preview already marked skip are skipped rows of this
    // import, and the result counts them (#656). It used to count only what
    // the commit itself skipped, so "SKIP 1" in the preview could end as
    // "1 skipped" with two rows skipped.
    const previewSkipped = Number((batch.stats as { skip?: number } | null)?.skip ?? 0) || 0;
    let created = 0,
      updated = 0,
      failed = 0,
      skipped = previewSkipped;
    const rowErrors = new Map<string, number>();

    // Whatever stops this commit, the batch says so (#569). It used to stay
    // "Committing" for ever with no error and no way to try again.
    try {
      // Never release a claim after partial work: retrying could repeat writes.
      const { records: existing } = await loadExisting(supabase, orgId, entity, batch.source);
      const sourceLabel =
        batch.source === "generic_csv"
          ? "your previous system"
          : (IMPORT_SOURCE_LABELS[batch.source as ImportSource] ?? "your previous system");

      /** One opening balance, as an open invoice marked as such. Nothing is
       *  sent and nothing is charged: the invoice is open, and the client is
       *  on the import's communications hold. */
      const writeOpeningBalance = async (
        clientId: string,
        amountCents: number,
        dueOn: string | null,
        note: string | null,
      ): Promise<string> => {
        const nowIso = new Date().toISOString();
        const today = nowIso.slice(0, 10);
        const due = dueOn ?? new Date(Date.now() + netDays * 86_400_000).toISOString().slice(0, 10);
        const description = `Opening balance carried over from ${sourceLabel}`;
        const { data: inv, error: iErr } = await supabase
          .from("invoices")
          .insert(
            newInvoice({
              organization_id: orgId,
              client_id: clientId,
              kind: "postpaid",
              status: "open",
              // No sales tax, whatever the org's rate: an opening balance is
              // historical, already taxed (or not) in the books it came from.
              // tax_cents and tax_rate_bps default to 0.
              subtotal_cents: amountCents,
              total_cents: amountCents,
              period_start: today,
              period_end: today,
              issued_at: nowIso,
              due_on: due,
              notes: note ? `${OPENING_BALANCE_NOTE}: ${note}` : OPENING_BALANCE_NOTE,
            }),
          )
          .select("id")
          .single();
        if (iErr) throw iErr;
        const { error: lErr } = await supabase
          .from("invoice_line_items")
          .insert({ invoice_id: inv.id, description, amount_cents: amountCents });
        if (lErr) {
          await supabase.from("invoices").delete().eq("id", inv.id);
          throw lErr;
        }
        return inv.id as string;
      };

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
            // Without a Geocodio key every address is one Nominatim request a
            // second, which on its own made a 1,000-row import take about 17
            // minutes (#617). The import spends at most IMPORT_GEOCODE_BUDGET_MS
            // on it; an address it did not reach is saved without a pin and
            // located later by "Geocode addresses" on the Routes page, which
            // finds every property with no coordinates.
            const geos = await geocodeAddresses(
              toGeocode.map(({ m }) => ({
                street: m.street,
                city: m.city,
                region: m.region,
                postal_code: m.postal_code,
              })),
              { nominatimBudgetMs: IMPORT_GEOCODE_BUDGET_MS },
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

      // ── Writes, in chunks (#617) ─────────────────────────────────────────
      //
      // A 1,000-row client import took 19 min 47 s. Most of it was geocoding
      // (above); the rest was five round trips per row, one after another: the
      // client insert, the row's target_id, a fresh read of every zone, the
      // property insert, and a skip's own update. The zones are now read once,
      // clients and properties go in IMPORT_WRITE_CHUNK at a time, and the
      // rows' results are written several at once: a chunk's target_ids as
      // soon as its clients are in, the skips at the end.
      //
      // The duplicate check still runs row by row in file order against an
      // index that includes the clients queued before it, so a file that names
      // one client twice still creates it once.
      const { matchZone } = await import("@/lib/zone-match");
      let zoneList: any[] | null = null;
      // A zone read that fails is not "this business has no zones" (#617).
      // It is tried twice; if both fail, every property this import writes
      // goes in with no zone and the result says why (zone_lookup_failed), so
      // the page can send the owner to "Re-run zone detection" rather than
      // leave them believing their zones matched nothing.
      let zoneLookupFailed = false;
      // Properties written with no zone, for whatever reason. The page says
      // how many.
      let unzoned = 0;
      const readZones = () =>
        supabase
          .from("zones")
          .select(
            "id, priority, account_type, postal_prefix, zip_codes, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes, enabled",
          )
          .eq("organization_id", orgId);
      const zoneFor = async (input: Parameters<typeof matchZone>[1]): Promise<string | null> => {
        if (zoneList === null && !zoneLookupFailed) {
          let res = await readZones();
          if (res.error) res = await readZones();
          if (res.error) {
            zoneLookupFailed = true;
            console.error("import: zones could not be read", res.error.message);
          } else zoneList = (res.data ?? []) as any[];
        }
        if (zoneLookupFailed) return null;
        const z = matchZone(zoneList as any[], input);
        return z ? (z.id as string) : null;
      };

      type NewClient = {
        rowId: string;
        action: string;
        id: string;
        m: any;
        // import_extras is 20261111050000's column; the generated types
        // (owned by #870) do not carry it yet.
        record: Database["public"]["Tables"]["clients"]["Insert"] & { import_extras?: Json | null };
      };
      const newClients: NewClient[] = [];
      const newProperties: Database["public"]["Tables"]["properties"]["Insert"][] = [];
      // Pets named on a client's row, and an amount owed on it, written once
      // the client and its address are in (#857).
      const newDogs: Database["public"]["Tables"]["dogs"]["Insert"][] = [];
      const newBalances: { rowId: string; clientId: string; cents: number }[] = [];
      let pets = 0;
      let openingBalances = 0;
      const skips: { rowId: string; action: string; targetId: string }[] = [];
      const failedClientIds = new Set<string>();
      const failRow = async (rowId: string, action: string, reason: string) => {
        failed += 1;
        rowErrors.set(reason, (rowErrors.get(reason) ?? 0) + 1);
        await markRowFailed(supabase, rowId, action, reason);
      };

      let unlinked = 0;
      const inParallel = async (jobs: (() => Promise<void>)[]) => {
        for (let i = 0; i < jobs.length; i += IMPORT_ROW_UPDATES_AT_ONCE) {
          await Promise.all(jobs.slice(i, i + IMPORT_ROW_UPDATES_AT_ONCE).map((j) => j()));
        }
      };

      const flushNewClients = async () => {
        if (!newClients.length) return;
        const chunk = newClients.splice(0);
        // A request that throws (a dropped connection) is handled like one
        // that answers with an error: the chunk is already off the queue, so
        // letting it escape would count these rows as created and write none.
        const insert = async (
          records: NewClient["record"][],
        ): Promise<{ message: string; code?: string } | null> => {
          try {
            const { error } = await supabase
              .from("clients")
              .insert(records as Database["public"]["Tables"]["clients"]["Insert"][]);
            return error;
          } catch (e) {
            return { message: (e as Error)?.message ?? String(e) };
          }
        };
        // The id is chosen here, so a primary-key conflict on it means this
        // very row is already in: the chunk's statement committed and only
        // its answer was lost. That row is inserted, not failed.
        const alreadyIn = (e: { message: string; code?: string }) =>
          e.code === "23505" && /clients_pkey/.test(e.message);
        const error = await insert(chunk.map((c) => c.record));
        let inserted = chunk;
        if (error) {
          // One statement fails whole. Insert this chunk's rows one at a time
          // so only the rows at fault fail, and the rest still go in.
          inserted = [];
          for (const c of chunk) {
            const oneErr = await insert([c.record]);
            if (!oneErr || alreadyIn(oneErr)) {
              inserted.push(c);
              continue;
            }
            created -= 1;
            failedClientIds.add(c.id);
            await failRow(c.rowId, c.action, oneErr.message ?? String(oneErr));
          }
        }
        // Each row points at its client as soon as the chunk is in, not at the
        // end of the file: a commit that stops later leaves no client it made
        // unclaimed by its row.
        await inParallel(
          inserted.map((c) => async () => {
            const link = async () => {
              try {
                const { error } = await supabase
                  .from("import_rows")
                  .update({ target_id: c.id })
                  .eq("id", c.rowId);
                return error;
              } catch (e) {
                return { message: (e as Error)?.message ?? String(e) };
              }
            };
            // Once more, then counted: the client is in either way, and a
            // row that cannot say which client it made is reported on the
            // result, not passed over.
            if ((await link()) && (await link())) unlinked += 1;
          }),
        );
        for (const c of inserted) {
          const m = c.m;
          if (m.balance_cents > 0) {
            newBalances.push({ rowId: c.rowId, clientId: c.id, cents: m.balance_cents });
          }
          // If the Clients row carried a service address, create a property
          // for it (auto-geocoded) so routing/pricing/DNA work downstream —
          // instead of silently dropping the address (finding #12).
          if (!(m.street && m.city)) continue;
          const geo = geoByRow.get(c.rowId) ?? null;
          // Type-appropriate zone matching (B3): the imported property
          // inherits the client's account type, so a commercial client
          // lands in a commercial zone even when a residential zone
          // covers the same ZIP.
          const importAccountType =
            m.account_type === "commercial" || m.account_type === "residential"
              ? m.account_type
              : null;
          const importZoneId = await zoneFor({
            postalCode: m.postal_code,
            point:
              geo?.latitude != null && geo?.longitude != null
                ? { lat: geo.latitude, lng: geo.longitude }
                : null,
            accountType: importAccountType,
          });
          // The id is chosen here so the row's pets can name their property
          // before it exists, as the client's id is for its rows.
          const propertyId = crypto.randomUUID();
          for (const pet of (m.pets ?? []) as PetName[]) {
            newDogs.push({
              organization_id: orgId,
              property_id: propertyId,
              name: pet.name,
              breed: pet.breed,
            });
          }
          newProperties.push({
            id: propertyId,
            organization_id: orgId,
            client_id: c.id,
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
        }
      };

      // Addresses saved with no map pin: the geocoder found nothing, or the
      // import's geocoding budget ran out first. The page says how many.
      let unpinned = 0;
      const flushNewProperties = async () => {
        while (newProperties.length) {
          const chunk = newProperties.splice(0, IMPORT_WRITE_CHUNK);
          const { error } = await supabase.from("properties").insert(chunk);
          if (!error) {
            unpinned += chunk.filter((p) => p.latitude == null).length;
            unzoned += chunk.filter((p) => p.zone_id == null).length;
            continue;
          }
          for (const p of chunk) {
            const { error: oneErr } = await supabase.from("properties").insert(p);
            // Non-fatal: the client is created; a failed property shouldn't
            // roll back the client. Logged for follow-up.
            if (oneErr) {
              console.error("import: property create failed", oneErr.message);
              continue;
            }
            if (p.latitude == null) unpinned += 1;
            if (p.zone_id == null) unzoned += 1;
          }
        }
      };

      /** The pets the client rows named, on the properties just written. A
       *  pet that cannot go in is logged, not fatal: the client is in. */
      const flushNewDogs = async () => {
        while (newDogs.length) {
          const chunk = newDogs.splice(0, IMPORT_WRITE_CHUNK);
          const { error } = await supabase.from("dogs").insert(chunk);
          if (!error) {
            pets += chunk.length;
            continue;
          }
          for (const d of chunk) {
            const { error: oneErr } = await supabase.from("dogs").insert(d);
            if (oneErr) console.error("import: pet create failed", oneErr.message);
            else pets += 1;
          }
        }
      };

      /** The amounts owed on client rows, as open invoices. A balance that
       *  cannot be written fails its row's balance only, with the reason in
       *  the row; the client is in. */
      const flushNewBalances = async () => {
        for (const b of newBalances.splice(0)) {
          try {
            await writeOpeningBalance(b.clientId, b.cents, null, null);
            openingBalances += 1;
          } catch (e) {
            const reason = (e as Error)?.message ?? String(e);
            rowErrors.set(reason, (rowErrors.get(reason) ?? 0) + 1);
            await supabase
              .from("import_rows")
              .update({ error: `Client imported, but not the balance: ${reason}` })
              .eq("id", b.rowId);
          }
        }
      };

      /** The skipped rows' outcome, written IMPORT_ROW_UPDATES_AT_ONCE at a time. */
      const writeRowResults = async () => {
        type Job = () => Promise<void>;
        const jobs: Job[] = [
          ...skips.map(
            (sk): Job =>
              async () => {
                // A duplicate of a row earlier in this file that then failed
                // has nothing to point at.
                if (failedClientIds.has(sk.targetId)) {
                  skipped -= 1;
                  await failRow(
                    sk.rowId,
                    sk.action,
                    "The same client appears earlier in this file, and that row could not be imported.",
                  );
                  return;
                }
                const { error } = await supabase
                  .from("import_rows")
                  .update({ action: "skip", target_id: sk.targetId })
                  .eq("id", sk.rowId);
                if (error) {
                  skipped -= 1;
                  await failRow(sk.rowId, sk.action, error.message);
                }
              },
          ),
        ];
        await inParallel(jobs);
      };

      /**
       * The rows the preview skipped as a repeat of a row above them in this
       * file (#656). They are not committed, but they depend on that row: each
       * is pointed at the client it made, or failed when that row failed, as
       * the commit did for such a row before the preview could see it.
       */
      const settleInFileTwins = async () => {
        const twins = (
          await selectAll<{ id: string; mapped: unknown; action: string; target_id: string | null }>(
            (from, to) =>
              supabase
                .from("import_rows")
                .select("id, mapped, action, target_id")
                .eq("batch_id", data.batchId)
                .eq("action", "skip")
                .is("target_id", null)
                .order("row_num")
                .range(from, to),
          )
        ).filter((r) => r.action === "skip" && r.target_id == null && r.mapped);
        await inParallel(
          twins.map((t) => async () => {
            const first = alreadyInDatabase("clients", t.mapped as any, null, existing);
            if (first && !failedClientIds.has(first)) {
              await supabase.from("import_rows").update({ target_id: first }).eq("id", t.id);
              return;
            }
            skipped -= 1;
            await failRow(
              t.id,
              "skip",
              "The same client appears earlier in this file, and that row could not be imported.",
            );
          }),
        );
      };

      for (const row of rows ?? []) {
        const m = row.mapped as any;
        try {
          const duplicate = alreadyInDatabase(entity, m, row.target_id, existing);
          if (duplicate) {
            // Written with the others after the loop (writeRowResults).
            skips.push({ rowId: row.id, action: row.action, targetId: duplicate });
            skipped += 1;
            continue;
          }
          if (entity === "clients") {
            if (row.action === "create") {
              // Queued, not written: flushNewClients inserts them a chunk at a
              // time (#617). The id is chosen here so the duplicate index can
              // name this client before the row exists, exactly as it used to
              // name it after.
              const clientId = crypto.randomUUID();
              newClients.push({
                rowId: row.id,
                action: row.action,
                id: clientId,
                m,
                record: {
                  id: clientId,
                  organization_id: orgId,
                  display_name: m.display_name,
                  account_type: m.account_type,
                  primary_email: m.primary_email,
                  primary_phone: m.primary_phone,
                  // The file's notes, then what the import adds: a billing
                  // address, and a summary of the columns no field consumed.
                  // The raw values are in import_extras (#857).
                  notes: joinNotes(m.notes, extrasSummary(sourceLabel, m.extras)),
                  ...(m.extras ? { import_extras: m.extras } : {}),
                  ...(m.company ? { company: m.company } : {}),
                  ...(m.tags?.length ? { tags: m.tags } : {}),
                  // An archived or inactive client in the old system comes in
                  // inactive here, with messaging off (product default, #857).
                  ...(m.active === false ? { active: false } : {}),
                  // A do-not-text flag is stored; nothing acts on it at import.
                  ...(m.do_not_text ? { sms_opt_out: true } : {}),
                  import_source: batch.source,
                  import_external_id: m.external_id,
                  import_batch_id: batch.id,
                  // Import comms hold: newly-imported clients must not receive
                  // automated communications until the org initiates contact
                  // (manual send clears it) or office lifts the hold. Only set
                  // on CREATE — updates leave an existing client's flag alone.
                  comms_paused: true,
                },
              });
              // Include clients created earlier in this file in the next check.
              rememberClient(
                existing.clients,
                {
                  id: clientId,
                  display_name: m.display_name,
                  primary_email: m.primary_email,
                  primary_phone: m.primary_phone,
                  import_source: batch.source,
                  import_external_id: m.external_id,
                  streets: [{ street: m.street, postal_code: m.postal_code }],
                },
                batch.source,
              );
              created += 1;
              if (newClients.length >= IMPORT_WRITE_CHUNK) await flushNewClients();
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
              const propZoneId = await zoneFor({
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
              // No coordinates on this path: "Geocode addresses" pins it later
              // and places it in its zone then.
              unpinned += 1;
              if (!propZoneId) unzoned += 1;
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
                  notes: joinNotes(m.notes, extrasSummary(sourceLabel, m.extras)),
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
              // "Per visit" in the file is both the plan's cadence (postpaid)
              // and how often the client is billed (after each visit): the
              // run that invoices (run_billing_cycles) reads the client's
              // billing_frequency, so a plan alone would still bill monthly.
              if (m.billing_frequency) {
                const { error: bfErr } = await supabase
                  .from("clients")
                  .update({ billing_frequency: m.billing_frequency })
                  .eq("id", row.target_id);
                if (bfErr) console.error("import: billing frequency not set", bfErr.message);
              }
              // What the plan's row said that the plan cannot hold: a file
              // with no frequency column, and the columns no field consumed.
              // A plan has no notes of its own, so it is an office note on
              // the client (#857).
              const planNote = joinNotes(
                m.frequency_in_file === false
                  ? `Imported plan from ${sourceLabel}: the file did not say how often. The plan is paused and weekly on paper; set how often before turning it on.`
                  : null,
                extrasSummary(sourceLabel, m.extras),
              );
              if (planNote) {
                const { error: nErr } = await supabase.from("client_notes").insert({
                  organization_id: orgId,
                  client_id: row.target_id,
                  property_id: prop.id,
                  audience: "office",
                  body: planNote.slice(0, 4000),
                  created_by: userId,
                });
                if (nErr) console.error("import: plan note failed", nErr.message);
              }
            }
          } else if (entity === "balances") {
            if (row.action === "create" && row.target_id) {
              const invoiceId = await writeOpeningBalance(
                row.target_id,
                m.amount_cents,
                m.due_on ?? null,
                joinNotes(m.note, extrasSummary(sourceLabel, m.extras)),
              );
              await supabase.from("import_rows").update({ target_id: invoiceId }).eq("id", row.id);
              created += 1;
            }
          }
        } catch (e: any) {
          failed += 1;
          const reason = e?.message ?? String(e);
          rowErrors.set(reason, (rowErrors.get(reason) ?? 0) + 1);
          await markRowFailed(supabase, row.id, row.action, reason);
        }
      }

      await flushNewClients();
      await flushNewProperties();
      await flushNewDogs();
      await flushNewBalances();
      await writeRowResults();
      if (entity === "clients") await settleInFileTwins();

      // No visits are generated here. Every imported plan is paused until the
      // owner turns it on (the owner's rule, Nov 10 2026, #857); resuming it
      // puts it on the schedule. And nothing is sent: no invite, no reminder,
      // no text, no charge. The clients are on the communications hold and
      // an opening balance is an open invoice nobody has been told about.

      const stats = {
        created,
        updated,
        failed,
        skipped,
        ...(pets ? { pets } : {}),
        ...(openingBalances ? { opening_balances: openingBalances } : {}),
        ...(entity === "services" && created ? { paused_plans: created } : {}),
        ...(unpinned ? { unpinned } : {}),
        ...(unzoned ? { unzoned } : {}),
        ...(zoneLookupFailed ? { zone_lookup_failed: true } : {}),
        // Clients created whose import row could not record them (#617).
        ...(unlinked ? { unlinked } : {}),
      };
      const nothingWentIn = failed > 0 && !created && !updated;
      const { error: finishError } = await supabase
        .from("import_batches")
        .update({
          status: nothingWentIn ? "failed" : "committed",
          // The preview's counts stay beside the commit's, so the page still
          // shows what the file held and "Try again" can restore them.
          stats: { ...previewStats(batch.stats), ...stats },
          error: nothingWentIn ? mostCommon(rowErrors) : null,
          committed_at: new Date().toISOString(),
        })
        .eq("id", data.batchId);

      if (finishError) throw new Error(finishError.message);
      const { error: supersedeError } = await supabase
        .from("import_batches")
        .update({ status: "cancelled", superseded_by: batch.id })
        .eq("organization_id", orgId)
        .eq("content_hash", contentHash)
        .neq("id", batch.id)
        .eq("status", "previewing")
        .is("commit_started_at", null);
      if (supersedeError) throw new Error(supersedeError.message);
      return { ...previewStats(batch.stats), ...stats };
    } catch (e) {
      await recordCommitFailure(
        supabase,
        batch.id,
        batch.stats,
        { created, updated, failed, skipped },
        e,
      );
      throw e;
    }
  });

// ── Undo (#857) ───────────────────────────────────────────────────────────

/** PostgREST puts an `in` list in the URL; 200 ids at a time keeps it short. */
const IN_CHUNK = 200;

async function countWhereIn(
  supabase: SupabaseClient<Database>,
  table: "visits" | "payments" | "invoices",
  column: string,
  ids: readonly string[],
  only?: { notOpen: true },
): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const base = supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .in(column, ids.slice(i, i + IN_CHUNK));
    const { count, error } = await (only?.notOpen ? base.neq("status", "open") : base);
    // A guard that cannot count must not read as "nothing to protect".
    if (error) throw new Error(error.message);
    n += count ?? 0;
  }
  return n;
}

/** Rows of `table` whose `column` is one of `ids`, read as T. The select
 *  string is built at runtime, so the row type is the caller's word. */
async function selectWhereIn<T>(
  supabase: SupabaseClient<Database>,
  table: "properties" | "invoices",
  columns: string,
  column: string,
  ids: readonly string[],
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const got = await selectAll<T>((a, b) =>
      supabase
        .from(table)
        .select(columns)
        .in(column, ids.slice(i, i + IN_CHUNK))
        .order("id")
        .range(a, b)
        .then((r) => ({ data: r.data as unknown as T[] | null, error: r.error })),
    );
    out.push(...got);
  }
  return out;
}

/** What a committed batch created, by id: the rows' targets, and for a
 *  clients file every client that carries the batch's id (a row whose
 *  target could not be recorded still made its client, #617). */
async function batchCreations(
  supabase: SupabaseClient<Database>,
  orgId: string,
  batch: { id: string; entity: string | null },
): Promise<{ ids: string[]; updated: number }> {
  const rows = await selectAll<{ action: string; target_id: string | null }>((a, b) =>
    supabase
      .from("import_rows")
      .select("action, target_id")
      .eq("batch_id", batch.id)
      .in("action", ["create", "update"])
      .order("row_num")
      .range(a, b),
  );
  const ids = new Set<string>();
  let updated = 0;
  for (const r of rows) {
    if (r.action === "update") updated += 1;
    else if (r.target_id) ids.add(r.target_id);
  }
  if ((batch.entity ?? "clients") === "clients") {
    const made = await selectAll<{ id: string }>((a, b) =>
      supabase
        .from("clients")
        .select("id")
        .eq("organization_id", orgId)
        .eq("import_batch_id", batch.id)
        .order("id")
        .range(a, b),
    );
    for (const c of made) ids.add(c.id);
  }
  return { ids: [...ids], updated };
}

/** Whether anything this batch created has been used since: visits on its
 *  clients, properties or plans; payments on its invoices or its clients'
 *  invoices; invoices written on its clients that it did not write. */
async function importUsage(
  supabase: SupabaseClient<Database>,
  orgId: string,
  batch: { id: string; entity: string | null },
): Promise<UndoUsage> {
  const { ids, updated } = await batchCreations(supabase, orgId, batch);
  const usage: UndoUsage = { visits: 0, payments: 0, laterInvoices: 0, updated };
  if (!ids.length) return usage;
  const entity = batch.entity ?? "clients";
  if (entity === "clients") {
    usage.visits = await countWhereIn(supabase, "visits", "client_id", ids);
    const invoices = await selectWhereIn<{ id: string; notes: string | null }>(
      supabase,
      "invoices",
      "id, notes",
      "client_id",
      ids,
    );
    usage.laterInvoices = invoices.filter(
      (i) => !(i.notes ?? "").startsWith(OPENING_BALANCE_NOTE),
    ).length;
    usage.invoices = invoices.length;
    const invoiceIds = invoices.map((i) => i.id);
    if (invoiceIds.length) {
      usage.payments = await countWhereIn(supabase, "payments", "invoice_id", invoiceIds);
    }
  } else if (entity === "properties") {
    usage.visits = await countWhereIn(supabase, "visits", "property_id", ids);
  } else if (entity === "services") {
    usage.visits = await countWhereIn(supabase, "visits", "subscription_id", ids);
  } else if (entity === "balances") {
    usage.payments =
      (await countWhereIn(supabase, "payments", "invoice_id", ids)) +
      (await countWhereIn(supabase, "invoices", "id", ids, { notOpen: true }));
    usage.invoices = ids.length;
  }
  return usage;
}

/**
 * Undo a committed import: delete everything it created, while nothing of
 * it has been used (undoRefusal). The deleting is ONE call to
 * undo_import_batch (20261111050000), which runs every guard again, checks
 * each delete's row count and rolls the whole thing back on any mismatch or
 * error. The first version ran eight deletes from here as the caller, and a
 * caller who could import but not bill was left with half a client: the
 * invoices survived RLS unseen and the client delete failed on them.
 *
 * The guards run here first too, so the sentence a person reads is the
 * page's, and a caller who cannot bill is refused before the function is
 * asked. The batch's rows stay, so the page can still say what it did.
 */
export const undoImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ batchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: batch, error: bErr } = await supabase
      .from("import_batches")
      .select("*")
      .eq("id", data.batchId)
      .maybeSingle();
    if (bErr) throw new Error(bErr.message);
    if (!batch || batch.organization_id !== orgId) throw new Error(IMPORT_NOT_FOUND);
    const usage = await importUsage(supabase, orgId, batch);
    const refusal = undoRefusal(batch, usage);
    if (refusal) throw new Error(refusal);
    // Deleting an invoice is a billing act, the permission the commit asked
    // for to write it. Asked before anything is deleted.
    if (usage.invoices) {
      try {
        await requirePermission(supabase, userId, "manage_client_billing");
      } catch {
        throw new Error(UNDO_NEEDS_BILLING);
      }
    }
    // The generated types (#870) do not know the function yet, so the call
    // is made through rpc's untyped shape.
    type RpcCall = (
      this: SupabaseClient<Database>,
      fn: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
    const { data: result, error } = await (supabase.rpc as unknown as RpcCall).call(
      supabase,
      "undo_import_batch",
      { _batch_id: batch.id },
    );
    if (error) throw new Error(error.message);
    const undone = Number((result as { undone?: number } | null)?.undone ?? 0);
    return { ok: true, undone };
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
      .eq("status", "previewing")
      .is("commit_started_at", null);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** "Try again" on an import that did not finish (#569). Puts the batch back
 *  to its preview, with every row that failed at commit back to what it was
 *  going to do, so the page can commit it again. Refused, with the reason,
 *  when the first attempt wrote anything (retryRefusal). */
export const retryImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ batchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: batch, error: bErr } = await supabase
      .from("import_batches")
      .select("*")
      .eq("id", data.batchId)
      .eq("organization_id", orgId)
      .single();
    if (bErr) throw new Error(bErr.message);

    let wroteClients = false;
    if ((batch.entity ?? "clients") === "clients") {
      const { count, error: cErr } = await supabase
        .from("clients")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("import_batch_id", batch.id);
      if (cErr) throw new Error(cErr.message);
      wroteClients = (count ?? 0) > 0;
    }
    const refusal = retryRefusal(batch, wroteClients);
    if (refusal) throw new Error(refusal);

    // The batch first, on the state it was read in, so two taps reopen it
    // once. Releasing commit_started_at also releases the file's reservation,
    // which is right here: nothing of it went in.
    let reopen = supabase
      .from("import_batches")
      .update({
        status: "previewing",
        commit_started_at: null,
        committed_at: null,
        error: null,
        stats: previewStats(batch.stats) as Json,
      })
      .eq("id", batch.id)
      .eq("status", batch.status);
    reopen = batch.commit_started_at
      ? reopen.eq("commit_started_at", batch.commit_started_at)
      : reopen.is("commit_started_at", null);
    const { data: reopened, error: rErr } = await reopen.select("id").maybeSingle();
    if (rErr) throw new Error(rErr.message);
    if (!reopened) {
      throw new Error(
        "This import changed while it was being reopened. Refresh to see where it is.",
      );
    }

    for (const action of ["create", "update"] as const) {
      const { error } = await supabase
        .from("import_rows")
        .update({ action, error: null, commit_failed_action: null })
        .eq("batch_id", batch.id)
        .eq("commit_failed_action", action);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });
