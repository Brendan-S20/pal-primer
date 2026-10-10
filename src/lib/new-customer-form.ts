// One public form per business: the rules, with nothing to render.
//
// ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
//
// A business had two public pages for the same stranger. /lead/{slug} asked
// for a name, an email and optionally a phone, an address, a dog count and a
// note, and wrote a `leads` row. /signup/{slug} asked for a ZIP, dogs and a
// frequency, priced them, then asked for a name, an email, a phone and an
// address, and took a card. Same person, same yard, two forms that asked most
// of the same questions in a different order, two settings pages, and an
// owner who had to decide which link to put on the website. The owner's words
// (2026-10-08): "there's a ton of overlap here; it should essentially be
// slimmed down to one to avoid confusion."
//
// Now /signup/{slug} is the one page and /lead/{slug} forwards to it. The page
// prices the yard where it can, and the visitor chooses: start service with a
// card, or just ask for a quote. Where it cannot price (the business has
// switched instant start off, the ZIP is outside every zone, Stripe is not
// ready) the same page is a quote request, with no dead end.
//
// Kept pure so the branch decision, the lead body and the redirect can be
// tested without a browser, a database or a server function in the way.

// ── Who the page is for, and what it offers ────────────────────────────────

/** The answer `getSignupQuote` gives, in the shape the decision needs. */
export type QuoteAnswer<Q = unknown> = { available: true; quote: Q } | { available: false };

export type FormBranch<Q = unknown> = {
  /** "Start service" is on offer: card, client, property, subscription. */
  canStartService: boolean;
  /** "Just send me a quote" is on offer: a lead the office follows up. */
  canRequestQuote: boolean;
  /** The price to show, when there is one. */
  quote: Q | null;
  /** Why the page is in the state it is, for the copy beside the buttons. */
  reason: "priced" | "not-priced-yet" | "no-zone" | "instant-off";
};

/**
 * Which way the form can go for this visitor.
 *
 * `instantStart` is the business's switch (Settings → Signup & quote form)
 * AND'ed with whether a card can actually be taken, which the server decides
 * (see getPublicSignupForm). `answer` is undefined until the visitor has asked
 * for a price.
 *
 * The rule the owner asked for is the last line of every branch: a quote
 * request is ALWAYS available, so no answer here is a dead end. The one
 * exception is a caller that has its own fallback and passes
 * `offerQuoteRequest: false` (walk mode, where the tech marks the door).
 */
export function decideFormBranch<Q>(input: {
  instantStart: boolean;
  answer?: QuoteAnswer<Q> | null;
  offerQuoteRequest?: boolean;
}): FormBranch<Q> {
  const canRequestQuote = input.offerQuoteRequest !== false;
  if (!input.instantStart) {
    return { canStartService: false, canRequestQuote, quote: null, reason: "instant-off" };
  }
  if (!input.answer) {
    return { canStartService: false, canRequestQuote, quote: null, reason: "not-priced-yet" };
  }
  if (!input.answer.available) {
    return { canStartService: false, canRequestQuote, quote: null, reason: "no-zone" };
  }
  return { canStartService: true, canRequestQuote, quote: input.answer.quote, reason: "priced" };
}

// ── What the quote request sends ───────────────────────────────────────────

/** Where a lead came from, as `leads.source` stores it. "website" is what the
 *  hosted lead form has always written, and stays the quote request's value
 *  so the counts in Settings and anything filtering on it keep their meaning. */
export const LEAD_SOURCE = {
  quoteRequest: "website",
  onlineSignup: "online_signup",
  doorSignup: "door_signup",
} as const;

export type QuoteRequestForm = {
  name: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  region: string;
  postal_code: string;
  dog_count: string;
  frequency: string;
  message: string;
};

/** The body /api/public/leads takes, from the merged form's fields. The
 *  endpoint is the one the hosted lead form always posted to, unchanged; the
 *  address it used to take as one free-text "address or ZIP" is assembled
 *  from the separate fields the merged form asks for. */
export function leadBodyFromForm(slug: string, f: QuoteRequestForm) {
  const regionZip = [f.region.trim(), f.postal_code.trim()].filter(Boolean).join(" ");
  const location = [f.street.trim(), f.city.trim(), regionZip].filter(Boolean).join(", ");
  const dogs = f.dog_count.trim() === "" ? undefined : Number(f.dog_count);
  return {
    slug,
    name: f.name.trim(),
    email: f.email.trim(),
    phone: f.phone.trim(),
    location,
    dog_count: dogs != null && Number.isFinite(dogs) ? dogs : undefined,
    frequency: f.frequency.trim(),
    message: f.message.trim(),
    source: LEAD_SOURCE.quoteRequest,
  };
}

/** The line under the form, word for word as the hosted lead form had it.
 *  Neither public form has ever shown an SMS consent checkbox or stored a
 *  consent record (see the PR that merged them, and
 *  tests/one-form-for-new-customers.test.ts); this is the disclosure there
 *  was, and it stays exactly as it was. */
export const QUOTE_REQUEST_DISCLOSURE = "We'll only use this to follow up about your quote.";

// ── The page's words, when the owner has not chosen their own ──────────────

export const FORM_DEFAULTS = {
  instant: {
    headline: "Get an instant quote",
    intro:
      "Tell us about your property and pets and we'll price it in seconds. Start service online, or ask us for a quote.",
  },
  quoteOnly: {
    headline: "Request a quote",
    intro: "Tell us about your property and pets and we'll get you a quote.",
  },
  confirmation: "Thanks, we got your request! We'll be in touch shortly to set up your service.",
} as const;

export type FormFields = { phone: boolean; location: boolean; dogCount: boolean; message: boolean };

export type FormConfig = {
  brandColor: string | null;
  logoUrl: string | null;
  /** The owner's own words, or "" when they have not set any. */
  headline: string;
  intro: string;
  confirmation: string;
  fields: FormFields;
};

/** `organizations.lead_form_config`, read defensively. Text the owner has not
 *  set comes back "", not as a default, so a settings page can show the
 *  default as a placeholder without saving it as if the owner had typed it. */
export function normalizeFormConfig(raw: unknown): FormConfig {
  const c = raw && typeof raw === "object" ? (raw as Record<string, any>) : {};
  const f = c.fields && typeof c.fields === "object" ? c.fields : {};
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    brandColor: text(c.brandColor) || null,
    logoUrl: text(c.logoUrl) || null,
    headline: text(c.headline),
    intro: text(c.intro),
    confirmation: text(c.confirmation),
    fields: {
      phone: f.phone !== false,
      location: f.location !== false,
      dogCount: f.dogCount !== false,
      message: f.message !== false,
    },
  };
}

/** What the page actually says: the owner's words, else the default for the
 *  mode the page is in. */
export function formCopy(cfg: FormConfig, instantStart: boolean) {
  const d = instantStart ? FORM_DEFAULTS.instant : FORM_DEFAULTS.quoteOnly;
  return {
    headline: cfg.headline || d.headline,
    intro: cfg.intro || d.intro,
    confirmation: cfg.confirmation || FORM_DEFAULTS.confirmation,
  };
}

/** Which questions the page asks. When a price is on offer the ZIP and the
 *  dogs are asked whatever the toggles say, because the price is made of
 *  them; the toggles still shape a quote-only page exactly as they shaped the
 *  hosted lead form. */
export function askedFields(fields: FormFields, instantStart: boolean): FormFields {
  if (!instantStart) return fields;
  return { ...fields, location: true, dogCount: true };
}

// ── The retired address ────────────────────────────────────────────────────

/**
 * Where /lead/{slug} sends a visitor now: the same business's /signup/{slug},
 * with every query parameter it arrived with (zone, ref, utm_*, embed, and
 * anything a tenant's own site appends), in the order it arrived.
 *
 * `searchStr` is the raw query string including its "?", or "". Taken raw
 * rather than re-serialised from a parsed object so nothing is reordered,
 * re-encoded or dropped on the way through.
 */
export function retiredLeadFormHref(slug: string, searchStr: string): string {
  const qs =
    searchStr && searchStr !== "?" ? (searchStr.startsWith("?") ? searchStr : `?${searchStr}`) : "";
  return `/signup/${encodeURIComponent(slug)}${qs}`;
}

// ── The office's view of where a lead came from ────────────────────────────

export type LeadSignupState = {
  status: string;
  refunded_at: string | null;
} | null;

/** The label on a row in Leads: a quote request, or a signup and how far it
 *  got. A signup that never paid is the most useful row on the page, because
 *  it is somebody who saw a price and stopped, and it says so. */
export function leadOriginLabel(source: string, signup: LeadSignupState): string {
  const isSignup = source === LEAD_SOURCE.onlineSignup || source === LEAD_SOURCE.doorSignup;
  if (!isSignup) {
    if (source === LEAD_SOURCE.quoteRequest) return "Quote request";
    // ai-receptionist.server.ts: capture_lead, and book_visit for a number
    // that is not a client (it is never booked, only made a lead).
    if (source === "sms_receptionist") return "Texted the AI receptionist";
    return source.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
  const where = source === LEAD_SOURCE.doorSignup ? "at the door" : "online";
  if (!signup) return `Started signup ${where}, didn't pay`;
  if (signup.refunded_at) return `Signed up ${where}, refunded`;
  if (signup.status === "provisioned") return `Started service ${where}`;
  if (signup.status === "failed") return `Signed up ${where}, couldn't finish`;
  return `Started signup ${where}, didn't pay`;
}
