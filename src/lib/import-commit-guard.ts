// When an import preview may still be committed, and which rows of it would
// create a client the business already has (#434).
//
// The commit used to check one thing: `status === "previewing"`. So a preview
// of a file that had already gone in, opened again from the list weeks later,
// still offered "Commit import (311 rows)" and would have created every client
// a second time. Two tabs, a double click or a retry did the same, because
// nothing stopped two commits of one preview running at once.
//
// What this file decides, so it can be tested without a database:
//   * commitRefusal: a preview that is closed, being committed, superseded by
//     a commit of the same file, or older than IMPORT_PREVIEW_TTL_MS, is not
//     committed. The server refuses it and the page says why.
//   * importContentHash: one fingerprint per file's rows, so "the same file"
//     means the same rows, whatever it was called.
//   * clientDuplicateIndex / findExistingClient: at commit time a row to
//     create is checked against the clients that exist THEN, not when the
//     preview was built, and skipped when it matches one.
//
// What makes a second commit impossible rather than unlikely is in SQL: the
// claim in commitImport is one UPDATE ... WHERE status = 'previewing', and the
// unique index from 20261015090000_an-import-went-in-twice.sql allows one
// committing or committed batch per file per business.

/** A preview this old is not committed: what it says it will create was
 *  worked out against the clients of that day. */
export const IMPORT_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

export type CommitRefusal = "committed" | "committing" | "superseded" | "closed" | "stale";

export type CommitBlock = {
  reason: CommitRefusal;
  /** The batch that already committed this file, when there is one. */
  committedBatchId: string | null;
  committedAt: string | null;
};

export type BatchState = {
  status: string;
  created_at: string;
  commit_started_at?: string | null;
  superseded_by?: string | null;
};

/** The status a person is shown. "committing" and "superseded" are not
 *  values of the import_status enum: they are 'previewing' with a claimed
 *  commit, and 'cancelled' because another batch committed the same file
 *  (see 20261015090000_an-import-went-in-twice.sql for why). */
export function importDisplayStatus(batch: BatchState): string {
  if (batch.status === "previewing" && batch.commit_started_at) return "committing";
  if (batch.status === "cancelled" && batch.superseded_by) return "superseded";
  return batch.status;
}

/** Why this batch cannot be committed now, or null when it can. */
export function commitRefusal(batch: BatchState, now: number = Date.now()): CommitRefusal | null {
  switch (importDisplayStatus(batch)) {
    case "previewing":
      break;
    case "committed":
      return "committed";
    case "committing":
      return "committing";
    case "superseded":
      return "superseded";
    default:
      return "closed";
  }
  const created = Date.parse(batch.created_at);
  if (!Number.isFinite(created) || now - created > IMPORT_PREVIEW_TTL_MS) return "stale";
  return null;
}

/** The sentence the server throws, and the page shows, for each refusal. */
export function refusalMessage(reason: CommitRefusal): string {
  switch (reason) {
    case "committed":
      return "This import has already been committed. Nothing was imported again.";
    case "committing":
      return "This import is already being committed. Nothing was imported twice.";
    case "superseded":
      return "This file was already imported. Committing this preview would add the same rows again, so it is closed. Start a new import if the file has changed.";
    case "stale":
      return "This preview is more than 24 hours old, so what it says it will create may no longer be true. Start a new import to check the file against your clients as they are now.";
    case "closed":
      return "This import is closed and cannot be committed. Start a new import instead.";
  }
}

// ── The file's fingerprint ─────────────────────────────────────────────────

/** JSON with every object's keys sorted, so a row read back from jsonb
 *  (which reorders keys) hashes the same as the row the browser sent. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** SHA-256 of what is being imported and the rows, in file order. The
 *  filename and the column mapping are left out: a renamed copy of a file is
 *  the same file, and mapping it differently does not make its clients new. */
export async function importContentHash(entity: string, rows: unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(`${entity}\n${canonicalJson(rows)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Clients the business already has ───────────────────────────────────────

export type ExistingClient = {
  id: string;
  display_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  import_source: string | null;
  import_external_id: string | null;
  /** Service addresses on file, for the name and address match. */
  streets?: { street: string | null; postal_code: string | null }[];
};

export type ClientRow = {
  display_name?: string | null;
  primary_email?: string | null;
  primary_phone?: string | null;
  external_id?: string | null;
  street?: string | null;
  postal_code?: string | null;
};

const squash = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The last ten digits, or null for anything too short to be a whole
 *  number: "555-0100" alone matches nobody. */
function phoneKey(p: string | null | undefined): string | null {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

const addressKey = (
  name: string | null | undefined,
  street: string | null | undefined,
  postal: string | null | undefined,
) => {
  const n = squash(name);
  const s = squash(street);
  return n && s ? `${n}::${s}::${squash(postal)}` : null;
};

export type ClientDuplicateIndex = {
  byExternal: Map<string, string>;
  byEmail: Map<string, string>;
  byPhone: Map<string, string>;
  byNameAndStreet: Map<string, string>;
};

export function clientDuplicateIndex(
  clients: ExistingClient[],
  source: string,
): ClientDuplicateIndex {
  const idx: ClientDuplicateIndex = {
    byExternal: new Map(),
    byEmail: new Map(),
    byPhone: new Map(),
    byNameAndStreet: new Map(),
  };
  for (const c of clients) {
    if (c.import_external_id && c.import_source === source) {
      idx.byExternal.set(c.import_external_id, c.id);
    }
    const email = (c.primary_email ?? "").trim().toLowerCase();
    if (email) idx.byEmail.set(email, c.id);
    const phone = phoneKey(c.primary_phone);
    if (phone) idx.byPhone.set(phone, c.id);
    for (const s of c.streets ?? []) {
      const k = addressKey(c.display_name, s.street, s.postal_code);
      if (k) idx.byNameAndStreet.set(k, c.id);
    }
  }
  return idx;
}

export type ExistingMatch = {
  id: string;
  by: "external_id" | "email" | "phone" | "name_and_address";
};

/** The client this row would duplicate, checked in the order a match is
 *  most certain: the old system's own id, then email, phone, and the name at
 *  the same service address. */
export function findExistingClient(
  row: ClientRow,
  idx: ClientDuplicateIndex,
): ExistingMatch | null {
  if (row.external_id && idx.byExternal.has(row.external_id)) {
    return { id: idx.byExternal.get(row.external_id)!, by: "external_id" };
  }
  const email = (row.primary_email ?? "").trim().toLowerCase();
  if (email && idx.byEmail.has(email)) return { id: idx.byEmail.get(email)!, by: "email" };
  const phone = phoneKey(row.primary_phone);
  if (phone && idx.byPhone.has(phone)) return { id: idx.byPhone.get(phone)!, by: "phone" };
  const k = addressKey(row.display_name, row.street, row.postal_code);
  if (k && idx.byNameAndStreet.has(k))
    return { id: idx.byNameAndStreet.get(k)!, by: "name_and_address" };
  return null;
}

// ── Every entity: is this row already in the database? ─────────────────────

/** What already exists, read once per preview and once per commit. */
export type ExistingRecords = {
  clients: ClientDuplicateIndex;
  /** `${client_id}::${street lowercased}::${postal_code}` */
  propertyKeys: Set<string>;
  /** `${client_id}::${dog name lowercased}` */
  dogKeys: Set<string>;
  clientsWithActivePlan: Set<string>;
  clientsWithOpeningBalance: Set<string>;
};

export const propertyKey = (
  clientId: string,
  street: string | null | undefined,
  postal: string | null | undefined,
) => `${clientId}::${(street ?? "").toLowerCase()}::${postal ?? ""}`;
export const dogKey = (clientId: string, name: string | null | undefined) =>
  `${clientId}::${(name ?? "").toLowerCase()}`;

/**
 * The record a row to CREATE would repeat, or null. `targetId` is the client
 * the preview resolved for a property, dog, plan or balance row.
 *
 * Only what is already in the database counts. Two rows for one client in the
 * same file are two plans, or two open invoices from an aged-receivables
 * export, and both are kept, as the preview always said.
 */
export function alreadyInDatabase(
  entity: string,
  mapped: ClientRow & { name?: string | null },
  targetId: string | null,
  existing: ExistingRecords,
): string | null {
  if (entity === "clients") return findExistingClient(mapped, existing.clients)?.id ?? null;
  if (!targetId) return null;
  if (entity === "properties") {
    return existing.propertyKeys.has(propertyKey(targetId, mapped.street, mapped.postal_code))
      ? targetId
      : null;
  }
  if (entity === "dogs")
    return existing.dogKeys.has(dogKey(targetId, mapped.name)) ? targetId : null;
  if (entity === "services") return existing.clientsWithActivePlan.has(targetId) ? targetId : null;
  if (entity === "balances")
    return existing.clientsWithOpeningBalance.has(targetId) ? targetId : null;
  return null;
}
