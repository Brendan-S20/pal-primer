// A directory quote sent again by the same person (#920).
//
// Within DIRECTORY_QUOTE_MERGE_HOURS, a second quote from the same email to
// the same business is not a second lead (lib/directory.ts). Until #920 it
// was not anything at all: the endpoint answered `merged: true` and threw the
// new ask away, so a customer who came back with another dog, a gate code or
// a different service was invisible to the business while their browser said
// "sent". The rules, which the shipped endpoint (routes/api/public/leads.ts)
// follows and tests/a-directory-quote-is-one-lead.test.ts pins:
//
//   * ONE ROW. The repeat never inserts a second lead.
//   * ONLY AN OPEN LEAD TAKES IT. "Open" is status 'new': nobody in the
//     office has acted on it yet. Once a lead is contacted, qualified,
//     converted or archived, a fresh ask is a fresh lead, so it lands at the
//     top of Leads as New instead of hiding inside a conversation that has
//     already moved on (or a client record that already exists).
//   * NOTHING IS OVERWRITTEN. The original columns (message, service, dogs,
//     how often, ZIP, booking answers) stay what the person first asked. The
//     new ask is APPENDED to the lead's message as a dated block, which is
//     what the office reads on Leads and what Convert to client carries into
//     the office note, and written to activity_log (kind
//     `lead.repeat_request`, meta.lead_id) in full.
//   * updated_at MOVES, so the lead comes back up in Leads.
//   * THE OFFICE IS TOLD, once per repeat, as "Repeat request: <name>", on
//     an event key of its own (lead-notify.server.ts). The new-lead key,
//     `lead:<id>`, would be swallowed by the unique (recipient, event_key)
//     index.
//   * A DOUBLE TAP IS NOT NEWS. The same ask again within
//     DIRECTORY_DOUBLE_TAP_MINUTES of the last one (the original, or the last
//     repeat) bumps updated_at and is written to activity_log as a double
//     tap, but appends nothing and tells nobody. The same ask after that is
//     the person asking again, and is a repeat like any other.
//
// The same for every service line: nothing here reads one.

import { frequencyLabel } from "@/lib/frequency-request";

/** How close together two identical asks have to be to be one tap twice. */
export const DIRECTORY_DOUBLE_TAP_MINUTES = 10;

/** leads.message's CHECK (leads_message_chk). An append that would break it
 *  is cut to fit, never refused: the full ask is in activity_log either way. */
export const LEAD_MESSAGE_MAX = 2000;

export const REPEAT_ACTIVITY_KIND = "lead.repeat_request";

/** The only status a repeat is merged into. */
export const OPEN_LEAD_STATUS = "new";

export type Pet = { name: string; breed: string };

/** One ask, in the shape the lead row stores it. */
export type DirectoryAsk = {
  message: string | null;
  serviceId: string | null;
  dogCount: number | null;
  frequency: string | null;
  location: string | null;
  pets: Pet[] | null;
  accessNotes: string | null;
  preferredStartDate: string | null;
};

/** The columns of a lead that hold its first ask. */
export type LeadAskColumns = {
  message?: string | null;
  service_id?: string | null;
  dog_count?: number | null;
  frequency?: string | null;
  location?: string | null;
  pets?: unknown;
  access_notes?: string | null;
  preferred_start_date?: string | null;
};

function cleanPetList(v: unknown): Pet[] | null {
  if (!Array.isArray(v)) return null;
  const pets = v
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({ name: String(p.name ?? ""), breed: String(p.breed ?? "") }));
  return pets.length ? pets : null;
}

export function askFromLeadRow(row: LeadAskColumns): DirectoryAsk {
  return {
    message: row.message ?? null,
    serviceId: row.service_id ?? null,
    dogCount: row.dog_count ?? null,
    frequency: row.frequency ?? null,
    location: row.location ?? null,
    pets: cleanPetList(row.pets),
    accessNotes: row.access_notes ?? null,
    preferredStartDate: row.preferred_start_date ?? null,
  };
}

/** Two asks with the same fingerprint say the same thing. Blank and missing
 *  are the same; the order of the fields is fixed. */
export function askFingerprint(a: DirectoryAsk): string {
  const s = (v: string | null) => (v ?? "").trim();
  return JSON.stringify([
    s(a.message),
    a.serviceId ?? "",
    a.dogCount ?? null,
    s(a.frequency),
    s(a.location),
    (a.pets ?? []).map((p) => [p.name.trim(), p.breed.trim()]),
    s(a.accessNotes),
    s(a.preferredStartDate),
  ]);
}

/** The same ask as the last one, sent within the double-tap window. */
export function isDoubleTap(opts: {
  ask: DirectoryAsk;
  last: { fingerprint: string; at: string | Date };
  now?: Date;
}): boolean {
  const now = (opts.now ?? new Date()).getTime();
  const at = new Date(opts.last.at).getTime();
  if (!Number.isFinite(at)) return false;
  return (
    askFingerprint(opts.ask) === opts.last.fingerprint &&
    now - at <= DIRECTORY_DOUBLE_TAP_MINUTES * 60_000
  );
}

function petsLine(pets: Pet[] | null): string {
  return (pets ?? [])
    .map((p) => (p.breed ? `${p.name || "Unnamed"} (${p.breed})` : p.name))
    .filter(Boolean)
    .join(", ");
}

/** "2026-11-13 11:42 UTC". The office reads it on Leads; one zone for every
 *  business, rather than the server's. */
export function repeatStamp(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The block appended to the lead for one repeat: when, the service named,
 * every answer that differs from what the lead already says (with what it
 * said), and the new message. An answer left out of the repeat is not a
 * change: the person did not take it back by not typing it again.
 */
export function repeatNoteBlock(opts: {
  ask: DirectoryAsk;
  previous: DirectoryAsk;
  serviceName: string | null;
  at: Date;
}): string {
  const { ask, previous } = opts;
  const lines = [`--- Asked again ${repeatStamp(opts.at)} ---`];
  const service = (opts.serviceName ?? "").trim();
  if (service) {
    lines.push(
      ask.serviceId && ask.serviceId !== previous.serviceId
        ? `Service: ${service} (new)`
        : `Service: ${service}`,
    );
  }
  const changed = (label: string, now: string, was: string) => {
    if (!now || now === was) return;
    lines.push(was ? `${label}: ${now} (was ${was})` : `${label}: ${now}`);
  };
  changed(
    "Dogs",
    ask.dogCount != null ? String(ask.dogCount) : "",
    previous.dogCount != null ? String(previous.dogCount) : "",
  );
  changed(
    "How often",
    ask.frequency ? frequencyLabel(ask.frequency) : "",
    previous.frequency ? frequencyLabel(previous.frequency) : "",
  );
  changed("ZIP", (ask.location ?? "").trim(), (previous.location ?? "").trim());
  changed("Pets", petsLine(ask.pets), petsLine(previous.pets));
  changed("Access", (ask.accessNotes ?? "").trim(), (previous.accessNotes ?? "").trim());
  changed(
    "Start date",
    (ask.preferredStartDate ?? "").trim(),
    (previous.preferredStartDate ?? "").trim(),
  );
  const message = (ask.message ?? "").trim();
  if (message) lines.push(message);
  return lines.join("\n");
}

/**
 * The lead's message with the block appended, inside LEAD_MESSAGE_MAX. The
 * original text is never cut: the block is, from its end, with a marker. If
 * not even the block's first line fits, null: the message is left as it is
 * and the ask lives in activity_log alone.
 */
export function appendRepeatNote(
  existing: string | null,
  block: string,
  max = LEAD_MESSAGE_MAX,
): string | null {
  const head = (existing ?? "").trimEnd();
  const sep = head ? "\n\n" : "";
  const room = max - head.length - sep.length;
  if (block.length <= room) return `${head}${sep}${block}`;
  const firstLine = block.split("\n", 1)[0];
  const cut = " [cut short]";
  if (room < firstLine.length + cut.length) return null;
  return `${head}${sep}${block.slice(0, room - cut.length).trimEnd()}${cut}`;
}
