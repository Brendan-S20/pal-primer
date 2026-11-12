// Nothing in a competitor's export is dropped silently (#857).
//
// A business that moves to HoundStack brings the file its old software
// wrote: Jobber's client export, Time To Pet's client list, Gingr's View All
// Owners page. The mapping step points each HoundStack field at one column,
// and until #857 every other column was discarded without a word: Jobber's
// Account Balance, Lead Source, Archived and reminder flags, a custom field
// a business had typed into for years.
//
// This is the pure half of the rule that replaced that. Every column of the
// file is either CONSUMED by the mapping (pointed at a field, or read by the
// row mapper as a helper: First + Last Name, Street 2, the Billing fallback)
// or LEFT OVER. A leftover column is shown on the mapping step and on the
// preview, and its values travel with each row as `extras`: on a client they
// are written to clients.import_extras as JSON, with a short summary at the
// end of the client's notes; on a dog, a plan or a balance the summary goes
// to the record's notes. Nothing is dropped, nothing is acted on.
//
// Also here: the undo guard. A committed batch can be taken back only while
// nothing it created has been used (no visits, no payments), and never when
// it changed clients the business already had, since what they said before
// was not kept.

/** Columns the client row mapper reads without a mapping entry. Every name
 *  is matched case-insensitively against the file's headers. */
export const FIRST_NAME_COLUMNS = [
  "First Name",
  "First name",
  "first_name",
  "Given Name",
  // Jobber's official sample file (help-center jobber-clients-sample-file.csv).
  "Client First Name",
];
export const LAST_NAME_COLUMNS = [
  "Last Name",
  "Last name",
  "last_name",
  "Family Name",
  "Surname",
  "Client Last Name",
];
export const ADDRESS_2_COLUMNS = [
  "Service Street 2",
  "Property Street 2",
  "Street 2",
  "Address Line 2",
  "address_line_2",
  "Address 2",
  "Unit",
  "Apt",
  "Suite",
];
/** Per-row Billing fallbacks (Jobber): when the Service address cells are
 *  empty on a given row, the row's Billing columns stand in. When both are
 *  present and differ, the billing address goes in a note. */
export const BILLING_FALLBACK_COLUMNS: Record<string, string[]> = {
  street: ["Billing Street 1", "Billing Street", "Billing street"],
  city: ["Billing City", "Billing city"],
  region: ["Billing State", "Billing Province", "Billing State/Province", "Billing state/province"],
  postal_code: [
    "Billing Zip code",
    "Billing Zip",
    "Billing Postal code",
    "Billing Zip/Postal Code",
    "Billing zip/postal code",
  ],
};
export const BILLING_ADDRESS_2_COLUMNS = ["Billing Street 2"];
export const BILLING_COUNTRY_COLUMNS = ["Billing Country"];
/** The company's name beside the person's (Jobber: "Company Name", "Client
 *  Company Name"). It is the display name when the row has no other, and
 *  clients.company otherwise. */
export const COMPANY_NAME_COLUMNS = [
  "Client Company Name",
  "Company Name",
  "Company",
  "Business Name",
];

const HELPERS_BY_ENTITY: Record<string, string[]> = {
  clients: [
    ...FIRST_NAME_COLUMNS,
    ...LAST_NAME_COLUMNS,
    ...ADDRESS_2_COLUMNS,
    ...Object.values(BILLING_FALLBACK_COLUMNS).flat(),
    ...BILLING_ADDRESS_2_COLUMNS,
    ...BILLING_COUNTRY_COLUMNS,
    ...COMPANY_NAME_COLUMNS,
  ],
  properties: [...ADDRESS_2_COLUMNS],
  dogs: [],
  services: [],
  balances: [],
};

const norm = (s: string) => s.trim().toLowerCase();

/** The file's columns the import reads for this entity and mapping: the
 *  mapped columns, and the helpers the row mapper looks up by name. */
export function consumedColumns(
  entity: string,
  mapping: Record<string, string | null | undefined>,
  headers: readonly string[],
): string[] {
  const helpers = new Set((HELPERS_BY_ENTITY[entity] ?? []).map(norm));
  const mapped = new Set(
    Object.values(mapping)
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map(norm),
  );
  return headers.filter((h) => mapped.has(norm(h)) || helpers.has(norm(h)));
}

/** The file's columns no field reads: kept, shown, never dropped. A header
 *  that is empty (an unnamed column Papa Parse calls "") is not a column. */
export function leftoverColumns(
  entity: string,
  mapping: Record<string, string | null | undefined>,
  headers: readonly string[],
): string[] {
  const used = new Set(consumedColumns(entity, mapping, headers).map(norm));
  return headers.filter((h) => h.trim() !== "" && !used.has(norm(h)));
}

/** The longest value kept per column. Longer is cut, not refused: a column
 *  of free text is still kept, just not all of it. */
export const EXTRA_VALUE_MAX = 500;

/** A row's values in the leftover columns, blank cells left out. Null when
 *  the row has nothing in any of them. Written as JSON, so it is the raw
 *  value as the file spelled it. */
export function rowExtras(
  raw: Record<string, unknown>,
  leftovers: readonly string[],
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const col of leftovers) {
    const v = raw[col];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s) continue;
    out[col] = s.length > EXTRA_VALUE_MAX ? `${s.slice(0, EXTRA_VALUE_MAX - 1)}…` : s;
  }
  return Object.keys(out).length ? out : null;
}

/** The most a summary adds to a notes field. The JSON holds the whole
 *  value; the summary is for a person skimming the client's page. */
export const EXTRAS_SUMMARY_MAX = 600;

/** "Imported from Jobber. Lead Source: Referral. Archived: FALSE." One line
 *  per import, short enough to sit under the notes a tech reads. */
export function extrasSummary(
  sourceLabel: string,
  extras: Record<string, string> | null | undefined,
): string | null {
  if (!extras) return null;
  const parts = Object.entries(extras).map(([k, v]) => `${k}: ${v.replace(/\s+/g, " ")}`);
  if (!parts.length) return null;
  let body = `Imported from ${sourceLabel}. ${parts.join(". ")}.`;
  if (body.length > EXTRAS_SUMMARY_MAX) {
    body = `${body.slice(0, EXTRAS_SUMMARY_MAX - 1)}…`;
  }
  return body;
}

/** Notes as they are stored: the file's own notes first, then whatever the
 *  import adds (a billing address, the leftover summary), one per line. */
export function joinNotes(...parts: (string | null | undefined)[]): string | null {
  const kept = parts.map((p) => (p ?? "").trim()).filter(Boolean);
  return kept.length ? kept.join("\n") : null;
}

export type PetName = { name: string; breed: string | null };

/** The most pets one cell may name. */
export const PETS_PER_ROW_MAX = 20;

/**
 * Pets packed into one cell on the client's row, as Gingr's "Animals" and
 * MoeGo's "Pets" columns do: "Rex, Bella" or "Rex (Lab); Bella (Poodle)"
 * or "Rex & Bella". A name in parentheses after the pet's is read as the
 * breed. Empty for a blank cell.
 */
export function parsePetNames(text: string | null | undefined): PetName[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: PetName[] = [];
  for (const part of text.split(/[;,|/\n]|\s+&\s+|\s+and\s+/i)) {
    const s = part.trim();
    if (!s) continue;
    const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(s);
    const name = (m ? m[1] : s).trim().slice(0, 80);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, breed: m && m[2].trim() ? m[2].trim().slice(0, 80) : null });
    if (out.length >= PETS_PER_ROW_MAX) break;
  }
  return out;
}

/** "TRUE", "yes", "1", "x" are yes; "FALSE", "no", "0" are no; anything else
 *  is not an answer. */
export function parseYesNo(text: string | null | undefined): boolean | null {
  const s = (text ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["true", "yes", "y", "1", "x", "on", "checked"].includes(s)) return true;
  if (["false", "no", "n", "0", "off", "unchecked"].includes(s)) return false;
  return null;
}

/** Whether a client row's status column says the client is no longer
 *  active. "Archived", "Inactive", "Former", "Cancelled", "TRUE" (in an
 *  Archived column), "No" (in an Active column) all do. Null for an empty
 *  cell. The column's own name says which way a yes/no reads. */
export function parseInactive(
  columnName: string | null,
  text: string | null | undefined,
): boolean | null {
  const s = (text ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/\b(inactive|archived|former|cancell?ed|closed|churned|lost)\b/.test(s)) return true;
  if (/\b(active|current)\b/.test(s)) return false;
  const yes = parseYesNo(s);
  if (yes === null) return null;
  // "Active: yes" is active; "Archived: yes" / "Inactive: yes" is not.
  const col = (columnName ?? "").toLowerCase();
  const saysActive = /\bactive\b/.test(col) && !/\binactive\b/.test(col);
  return saysActive ? !yes : yes;
}

// ── Undo ───────────────────────────────────────────────────────────────────

export type UndoUsage = {
  /** Visits on anything this batch created (a client, a property, a plan). */
  visits: number;
  /** Payments on invoices of anything this batch created. */
  payments: number;
  /** Invoices on the clients this batch created that it did not write itself. */
  laterInvoices: number;
  /** Rows the commit updated rather than created. */
  updated: number;
  /** Invoices on what this batch created (its own opening balances and any
   *  written since). Deleting them is a billing act. */
  invoices?: number;
};

/** Why an undo is refused to someone who can import but not bill: the
 *  function asks the same before it deletes anything. */
export const UNDO_NEEDS_BILLING =
  "Undoing this import deletes the opening balances it wrote, which needs the billing permission. Ask an owner to undo it.";

/** Why a committed batch cannot be undone, or null when it can. The product
 *  rule (Nov 10 2026): undo per batch only while no record in the batch has
 *  visits or payments. Updates are refused too: the values a client had
 *  before the import were not kept, so there is nothing to put back. */
export function undoRefusal(
  batch: { status: string; undone_at?: string | null; committed_at?: string | null },
  usage: UndoUsage,
): string | null {
  if (batch.undone_at) return "This import has already been undone.";
  if (batch.status !== "committed" && batch.status !== "failed") {
    return "Only an import that has been committed can be undone.";
  }
  if (!batch.committed_at) return "Only an import that has been committed can be undone.";
  if (usage.updated > 0) {
    return `This import changed ${usage.updated} client${usage.updated === 1 ? "" : "s"} you already had, and their earlier values were not kept, so it cannot be undone. Edit those clients by hand instead.`;
  }
  const used: string[] = [];
  if (usage.visits > 0) used.push(`${usage.visits} visit${usage.visits === 1 ? "" : "s"}`);
  if (usage.payments > 0) used.push(`${usage.payments} payment${usage.payments === 1 ? "" : "s"}`);
  if (usage.laterInvoices > 0)
    used.push(
      `${usage.laterInvoices} invoice${usage.laterInvoices === 1 ? "" : "s"} written since`,
    );
  if (used.length) {
    return `This import is in use: ${used.join(", ")} on what it added. Undo is only possible before anything from the import has visits or payments. Archive or edit the records by hand instead.`;
  }
  return null;
}

/** What Undo on a committed import asks before it deletes anything. */
export const IMPORT_UNDO_CONFIRM = {
  title: "Undo this import?",
  description:
    "Everything this import added is deleted: the clients, addresses, pets, plans and opening balances it created. Clients you already had are not touched. This cannot be undone, but the file can be imported again.",
  confirmLabel: "Undo import",
  cancelLabel: "Keep it",
  destructive: true,
} as const;
