// What a stop card says about the yard, the dogs, the stations and the money,
// decided here so the rules can be tested without rendering a card.
//
// The owner, using the app as a technician on 2026-10-02: "There's no way to
// see the yard area/outline, nor see how many dogs. I am not able to tell if
// this means stations wouldn't be visible as well. There's nothing to indicate
// that they paid cash." Each of those was a fact the database had and the
// card did not draw -- the dogs line rendered NOTHING when the property had no
// dog rows, which in the demo business was 99 stops out of 110, so silence was
// the normal case and meant nothing.

/** A dog as the card reads it. */
export type StopDog = { name?: string | null; temperament?: string | null; id?: string | null };

/** What my_day_stop_facts answers for one visit, camel-cased. Absent when the
 *  function could not be asked (an older cached day, or a database the
 *  migration has not reached yet), and every reader below copes with that. */
export type StopFacts = {
  /** The dog count the subscription is priced on. */
  dogCount: number | null;
  autopay: boolean;
  cardOnFile: boolean;
  paysCashCheck: boolean;
  /** A line for this visit on a non-void invoice. Missing in older cached days. */
  hasInvoiceLine?: boolean;
  openBalanceCents: number;
  /** Collected in the field and not yet confirmed by the office. */
  awaitingCents: number;
};

/** The row the RPC returns, as PostgREST hands it over. */
export type StopFactsRow = {
  visit_id: string;
  dog_count: number | null;
  autopay: boolean | null;
  card_on_file: boolean | null;
  pays_cash_check: boolean | null;
  has_invoice_line?: boolean | null;
  open_balance_cents: number | string | null;
  awaiting_cents: number | string | null;
};

export function stopFactsFromRow(r: StopFactsRow): StopFacts {
  return {
    dogCount: typeof r.dog_count === "number" ? r.dog_count : null,
    autopay: !!r.autopay,
    cardOnFile: !!r.card_on_file,
    paysCashCheck: !!r.pays_cash_check,
    hasInvoiceLine: r.has_invoice_line === true,
    // bigint arrives as a number from PostgREST, or a string past 2^53; a
    // balance is never that large, but Number() is right either way.
    openBalanceCents: Number(r.open_balance_cents ?? 0) || 0,
    awaitingCents: Number(r.awaiting_cents ?? 0) || 0,
  };
}

// ── Dogs ────────────────────────────────────────────────────────────────────

export type DogsLine =
  /** Named, from the dog records. Aggressive ones still drawn red. */
  | { kind: "named"; dogs: StopDog[] }
  /** No records, but the subscription says how many. */
  | { kind: "count"; count: number }
  /** Neither. Said, not left blank. */
  | { kind: "none" };

/** The dogs line is never silent: names when there are records, the priced
 *  count when there are not, and "No dogs on file" when there is neither. */
export function dogsLine(dogs: unknown, dogCount: number | null | undefined): DogsLine {
  const list = (Array.isArray(dogs) ? dogs : dogs ? [dogs] : []).filter(
    (d): d is StopDog => !!d && typeof d === "object",
  );
  if (list.length > 0) return { kind: "named", dogs: list };
  if (typeof dogCount === "number" && Number.isFinite(dogCount) && dogCount > 0) {
    return { kind: "count", count: Math.floor(dogCount) };
  }
  return { kind: "none" };
}

// ── Money ───────────────────────────────────────────────────────────────────

export type PaymentMode = "autopay" | "cash_check" | "invoiced";

/** How this customer pays, in the order a tech needs it: a card that is
 *  charged automatically means nothing to collect; a customer whose last
 *  payment was cash or a check may hand some over. "Invoiced" requires a real
 *  invoice line for this visit, regardless of visit status. A missing RPC
 *  field or an older cached day cannot establish that a visit was invoiced. */
export function paymentMode(
  f: Pick<StopFacts, "autopay" | "cardOnFile" | "paysCashCheck" | "hasInvoiceLine">,
): PaymentMode | null {
  if (f.autopay && f.cardOnFile) return "autopay";
  if (f.paysCashCheck) return "cash_check";
  return f.hasInvoiceLine === true ? "invoiced" : null;
}

/** What is still owed once the collections already waiting are counted: the
 *  most a tech can record, and the amount the form starts at. */
export function dueCents(f: Pick<StopFacts, "openBalanceCents" | "awaitingCents">): number {
  return Math.max(Math.round(f.openBalanceCents) - Math.round(f.awaitingCents), 0);
}

/** "$40.00", in the tech's locale. US dollars: every business on the platform
 *  bills in them today, and the invoices this is a balance of say so. */
export function formatMoney(cents: number, locale?: string): string {
  // narrowSymbol: "$" rather than Chinese's "US$". It is the only dollar
  // on the platform, and the invoice the customer holds says "$".
  const s = new Intl.NumberFormat(locale ?? "en-US", {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
  }).format(cents / 100);
  // Arabic writes "1,250.00 US$" behind a right-to-left mark, and inside a
  // right-to-left line the bidi algorithm then moves the $ to the other side
  // of "US": the screen read "$US 1,250.00". An amount is one left-to-right
  // unit, so it goes in a left-to-right isolate (U+2066 … U+2069) instead.
  if (locale?.toLowerCase().startsWith("ar")) {
    return `\u2066${s.replace(/[\u200e\u200f\u061c]/g, "")}\u2069`;
  }
  return s;
}

/** Dollars as typed ("40", "40.5", "$1,040.00") to cents, or null when it is
 *  not an amount. Two decimal places at most: a third is a typo, not a
 *  fraction of a cent. */
export function parseDollars(raw: string): number | null {
  const s = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return Number.isFinite(cents) ? cents : null;
}

/** Why an amount cannot be recorded, as a key under `collect.*`, or null. */
export function collectionAmountProblem(
  cents: number | null,
  due: number,
): "enterAmount" | "moreThanDue" | null {
  if (cents == null || cents <= 0) return "enterAmount";
  if (cents > due) return "moreThanDue";
  return null;
}

/** The most the customer still owes, in cents, when record_field_collection
 *  refused an amount as too much ("That is more than this customer owes
 *  ($25.00). Enter $25.00 or less."), so My Day can say it in the tech's
 *  language. Null for any other error. */
export function moreThanOwedFromRefusal(message: string | null | undefined): number | null {
  const m = /^That is more than this customer owes \(\$([\d,]+\.\d{2})\)/.exec(message ?? "");
  return m ? parseDollars(m[1]) : null;
}

// ── The yard ────────────────────────────────────────────────────────────────

export type Polygon = { type: "Polygon"; coordinates: number[][][] };

/** The outer ring of a stored boundary, or null when it is not a polygon a
 *  map could draw. properties.boundary is GeoJSON written by BoundarySketch;
 *  anything else -- a null, a half-saved sketch, a point -- is "no outline". */
export function boundaryRing(boundary: unknown): number[][] | null {
  const b = boundary as Partial<Polygon> | null | undefined;
  if (!b || b.type !== "Polygon" || !Array.isArray(b.coordinates)) return null;
  const ring = b.coordinates[0];
  if (!Array.isArray(ring)) return null;
  const pts = ring.filter(
    (p) =>
      Array.isArray(p) &&
      p.length >= 2 &&
      Number.isFinite(Number(p[0])) &&
      Number.isFinite(Number(p[1])),
  );
  return pts.length >= 3 ? pts.map((p) => [Number(p[0]), Number(p[1])]) : null;
}

/**
 * The outline as an SVG path inside a `size` square, north up.
 *
 * NOT A MAP, on purpose. A stop card on a 30-stop day is 30 cards, and a map
 * per card is 30 tile loads before the tech has scrolled -- billed per load
 * once the maps move to Google. The shape of the yard needs no tiles, so the
 * card draws it from the coordinates it already has, and the real map (the
 * shared BoundaryPreview) loads only when the tech taps to open it.
 *
 * Longitude is scaled by cos(latitude) so a square yard stays square away
 * from the equator.
 */
export function outlinePath(boundary: unknown, size: number, pad = 4): string | null {
  const ring = boundaryRing(boundary);
  if (!ring) return null;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const k = Math.cos((lat0 * Math.PI) / 180) || 1;
  const xs = ring.map((p) => p[0] * k);
  const ys = ring.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY);
  if (!(span > 0)) return null;
  const scale = (size - pad * 2) / span;
  // Centred on both axes, so a long thin yard sits in the middle.
  const offX = (size - (maxX - minX) * scale) / 2;
  const offY = (size - (maxY - minY) * scale) / 2;
  const pts = ring.map((_, i) => {
    const x = offX + (xs[i] - minX) * scale;
    const y = offY + (maxY - ys[i]) * scale; // north up
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return `M${pts.join("L")}Z`;
}

/** The sketched area in the units a US crew reads: square feet for a yard,
 *  acres past 15,000 sq ft -- the same thresholds as BoundarySketch's
 *  formatArea, so the office and the tech quote the same number. */
export function areaParts(
  sqm: number | null | undefined,
): { unit: "sqft" | "acres"; value: number } | null {
  if (sqm == null || !Number.isFinite(Number(sqm)) || Number(sqm) <= 0) return null;
  const sqft = Number(sqm) * 10.7639;
  if (sqft < 15000) return { unit: "sqft", value: Math.round(sqft) };
  return { unit: "acres", value: Math.round((Number(sqm) / 4046.8564) * 100) / 100 };
}

// ── Stations ────────────────────────────────────────────────────────────────

export type StopStation = {
  id: string;
  label?: string | null;
  station_number?: number | null;
  section?: string | null;
  location_description?: string | null;
  sort_order?: number | null;
  active?: boolean | null;
  last_serviced_on?: string | null;
};

/** The property's active stations in the order the office set: the same
 *  order (sort_order, then number, then label) as the client's stations
 *  panel, so "the third one" means the same bin to both. */
export function activeStations(stations: unknown): StopStation[] {
  const list = (Array.isArray(stations) ? stations : []) as StopStation[];
  return list
    .filter((s) => s && s.active !== false)
    .slice()
    .sort(
      (a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        (a.station_number ?? Number.MAX_SAFE_INTEGER) -
          (b.station_number ?? Number.MAX_SAFE_INTEGER) ||
        String(a.label ?? "").localeCompare(String(b.label ?? "")),
    );
}

/** A fresh idempotency key for one collection, minted before the first
 *  attempt. crypto.randomUUID where the WebView has it; the same v4 shape
 *  from getRandomValues where it does not (iOS before 15.4). */
export function newClientKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Newest service day per station: the visit's scheduled day when the log
 *  has one, else the day it was logged. One implementation for the office's
 *  stations panel (listStations) and the tech's card, so "last serviced"
 *  cannot mean two things. */
export function lastServicedByStation(
  logs: {
    waste_station_id: string;
    serviced_at?: string | null;
    visits?: { scheduled_on?: string | null } | { scheduled_on?: string | null }[] | null;
  }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of logs ?? []) {
    const v = Array.isArray(l.visits) ? l.visits[0] : l.visits;
    const when = v?.scheduled_on ?? (l.serviced_at ? String(l.serviced_at).slice(0, 10) : null);
    if (!when) continue;
    const cur = out[l.waste_station_id];
    if (!cur || when > cur) out[l.waste_station_id] = when;
  }
  return out;
}
