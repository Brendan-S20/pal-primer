// A long office form, kept on the device while it is being filled in
// (gaps-r2-12, extends R2-33 / uxqa-13).
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
//
// Setup step 1 (services, name, phone, address, time zone) and the five-step
// new-client wizard held everything in React state and nowhere else. A phone
// browser reload, Android back, or the app being killed in the background
// emptied the form, and the wizard went back to step 1.
//
// ── THE SAME SHAPE AS THE WALK REPORT DRAFT ───────────────────────────────
//
// lib/offline/walk-drafts.ts solved this for the walk card (#610): keyed by
// user (and visit), read back on mount, written as it is typed, cleared once
// the thing is saved and on sign-out. This is that pattern for a form, in
// localStorage rather than IndexedDB because a form is small, synchronous to
// read, and needs no schema version.
//
// ── KEYED BY USER, ORGANIZATION AND FORM ──────────────────────────────────
//
// So a draft is read back only by the person who typed it, in the business it
// was typed for: an owner who also runs a second business, or a shared office
// laptop, never sees the wrong one. Sign-out drops every draft on the device
// (lib/offline/read-cache.ts, signOutAndClearDevice and the SIGNED_OUT
// backstop).
//
// ── NEVER A SECRET OR A CARD ──────────────────────────────────────────────
//
// Callers choose the fields they keep, and leave out gate codes, passwords and
// anything about a card. `stripSensitive` is the backstop: any field whose
// NAME says it is one of those is dropped before anything is written, however
// deep it sits.

export const FORM_DRAFT_PREFIX = "hs:form-draft:";

/** A draft older than this is dropped rather than offered back. */
export const FORM_DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const VERSION = 1;

type Stored = { v: number; savedAt: number; value: unknown };

const SENSITIVE_FIELD =
  /(password|passcode|passwd|secret|token|card|cvc|cvv|iban|routing|account_?number|ssn|gate_?code|lock_?box|pin_?code)/i;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The storage key, or null when there is no one (or no business) to key by.
 *  No key means no draft: an unattributable draft is one nobody may read. */
export function formDraftKey(
  userId: string | null | undefined,
  orgId: string | null | undefined,
  form: string,
): string | null {
  if (!userId || !orgId || !form) return null;
  return `${FORM_DRAFT_PREFIX}${userId}:${orgId}:${form}`;
}

/** The new-client wizard's form name. A wizard started from a lead or a quote
 *  keeps its own draft, so one lead's answers never open under another's, or
 *  under a blank wizard. */
export function newClientDraftForm(
  fromLead: { id: string } | null,
  fromQuote: { id: string } | null,
): string {
  if (fromQuote) return `new-client:quote:${fromQuote.id}`;
  if (fromLead) return `new-client:lead:${fromLead.id}`;
  return "new-client";
}

/** Whether what is on screen is worth keeping: anything the person changed
 *  from how the form opened. Opening a form and leaving it is not a draft. */
export function draftDiffers(initialJson: string, currentJson: string): boolean {
  return initialJson !== currentJson;
}

/** A copy with every field whose name marks a secret or card data removed. */
export function stripSensitive<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripSensitive(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD.test(k)) continue;
      out[k] = stripSensitive(v);
    }
    return out as T;
  }
  return value;
}

export function saveFormDraft(key: string | null, value: unknown, now = Date.now()): void {
  if (!key) return;
  const store = storage();
  if (!store) return;
  try {
    const row: Stored = { v: VERSION, savedAt: now, value: stripSensitive(value) };
    store.setItem(key, JSON.stringify(row));
  } catch {
    // Full or blocked storage is the old behaviour, not a new failure: the
    // form is still on screen and still saves.
  }
}

export function loadFormDraft<T>(key: string | null, now = Date.now()): T | null {
  if (!key) return null;
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const row = JSON.parse(raw) as Partial<Stored>;
    if (
      row?.v !== VERSION ||
      typeof row.savedAt !== "number" ||
      now - row.savedAt > FORM_DRAFT_TTL_MS ||
      row.value == null ||
      typeof row.value !== "object"
    ) {
      store.removeItem(key);
      return null;
    }
    return row.value as T;
  } catch {
    try {
      store.removeItem(key);
    } catch {
      // Nothing to do.
    }
    return null;
  }
}

export function clearFormDraft(key: string | null): void {
  if (!key) return;
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to do.
  }
}

/** Every form draft on the device, whoever wrote it. Called on sign-out. */
export function clearAllFormDrafts(): void {
  const store = storage();
  if (!store) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(FORM_DRAFT_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    // Best effort.
  }
}
