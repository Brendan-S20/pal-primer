// A lead, turned into what the new-client wizard starts from.
//
// Found 2026-09-27 by a tester playing an owner switching from Jobber. Lead
// "Lauren Woods" arrived with ZIP 10001, three dogs and a weekly frequency;
// "Convert to client" produced a client with no property, no dogs, no service
// and a status of Inactive, because the conversion copied four fields (name,
// email, phone, message) and put the message in `clients.notes`, a column no
// screen in the app displays. Everything the prospect had told us about their
// yard stayed on the lead.
//
// So conversion is no longer a one-tap insert. It opens the same five-step
// wizard every other new client goes through, started from the lead, and the
// owner finishes it with a property, dogs and a plan. This file is the pure
// half of that: which leads can be converted, and what the wizard's fields
// start as. No I/O, so the mapping is tested without a browser or a database.
//
// What a lead actually holds (supabase/migrations/20260701195313, plus
// organization_id from 20260710180000 and converted_client_id from
// 20260928090000): name, email, phone, company, location, dog_count, frequency,
// message, source, status, contacted_at, converted_at. `location` is free text
// the public form labels "Service address or ZIP", and `frequency` is free text
// from the embeddable JSON endpoint and the demo seed. Neither is structured,
// so both are parsed conservatively here, and whatever cannot be placed in a
// field is kept in the office note rather than dropped.

/** The frequencies the wizard's Plan step offers, in its own spelling. */
export const WIZARD_FREQUENCIES = ["weekly", "biweekly", "twice_weekly", "monthly", "one_time"] as const;
export type WizardFrequency = (typeof WIZARD_FREQUENCIES)[number];

/** onboardClient accepts at most this many dogs. */
export const MAX_WIZARD_DOGS = 20;

/** The lead columns conversion reads. Mirrors `leads` in types.ts. */
export type ConvertibleLead = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  location: string | null;
  dog_count: number | null;
  frequency: string | null;
  message: string | null;
  source: string;
  status: string;
  converted_client_id: string | null;
  /** The service the lead asked for (the catalog; a walk, not a cleanup),
   *  when the lead form or the receptionist recorded one. Optional: the
   *  column is read defensively, so a lead from before it exists, or a
   *  database without it yet, is a lead with no service. */
  service_id?: string | null;
};

export type WizardDog = {
  name: string;
  breed: string;
  weightClass: string;
  // The dog_temperament enum's own values; the database refuses anything else.
  temperament: "friendly" | "nervous" | "aggressive" | "unknown";
  notes: string;
};

export const BLANK_DOG: WizardDog = {
  name: "",
  breed: "",
  weightClass: "",
  temperament: "unknown",
  notes: "",
};

export type WizardPrefill = {
  displayName: string;
  primaryEmail: string;
  primaryPhone: string;
  street: string;
  city: string;
  region: string;
  postalCode: string;
  /** One row per dog the lead reported, unnamed. See leadToWizardPrefill. */
  dogs: WizardDog[];
  /** null when the lead named no frequency the wizard recognises. */
  frequency: WizardFrequency | null;
  /** The business's service the plan is for, when the lead asked for one;
   *  null means the business's default, as every client before the catalog.
   *  The wizard prefills the price from it through the one pricing rule
   *  (servicePriceCents) when the business sells more than one thing. */
  serviceId: string | null;
  officeNote: string;
};

/** The wizard's starting state for a client typed in by hand. */
export const EMPTY_PREFILL: WizardPrefill = {
  displayName: "",
  primaryEmail: "",
  primaryPhone: "",
  street: "",
  city: "",
  region: "",
  postalCode: "",
  dogs: [BLANK_DOG],
  frequency: null,
  serviceId: null,
  officeNote: "",
};

// ── Can this lead be converted? ──────────────────────────────────────────

export type LeadConversionState =
  /** Not converted yet: offer "Convert to client". */
  | { kind: "convertible" }
  /** Converted, and we know which client it became: offer "Open client". */
  | { kind: "linked"; clientId: string }
  /** Marked converted by hand from the status menu, or converted before the
   *  link existed and matched no client by email, or its client was deleted.
   *  Converting it again would make a second record of somebody who is already
   *  a customer, so neither action is offered. */
  | { kind: "converted-unlinked" };

export function leadConversionState(
  lead: Pick<ConvertibleLead, "status" | "converted_client_id">,
): LeadConversionState {
  // The link wins over the status. A lead that became a client and was later
  // moved back to "contacted" in the status menu is still that client; offering
  // to convert it again is how the same household ends up on the books twice.
  if (lead.converted_client_id) return { kind: "linked", clientId: lead.converted_client_id };
  if (lead.status === "converted") return { kind: "converted-unlinked" };
  return { kind: "convertible" };
}

// ── Frequency ────────────────────────────────────────────────────────────

/** Map a lead's free-text frequency onto the Plan step's options, or null.
 *  Order matters: "every 2 weeks", "twice a week" and "once a week" all
 *  contain "week", and "twice a month" is every other week, not twice weekly. */
export function normalizeLeadFrequency(raw: string | null | undefined): WizardFrequency | null {
  if (!raw) return null;
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[_\-/]+/g, " ")
    .replace(/\s+/g, " ");
  if (!s) return null;
  const twice = /\b(twice|two times|2 times|2x|semi ?weekly)\b/.test(s);
  if (twice && /\bmonth/.test(s)) return "biweekly";
  if (twice) return "twice_weekly";
  if (/\b(bi ?weekly|every (other|2|two) weeks?|fortnight(ly)?)\b/.test(s)) return "biweekly";
  if (/\b(monthly|month|every (4|four) weeks)\b/.test(s)) return "monthly";
  if (/\b(weekly|weeks?)\b/.test(s)) return "weekly";
  if (/\b(one time|onetime|once|one off|single)\b/.test(s)) return "one_time";
  return null;
}

// ── Location ─────────────────────────────────────────────────────────────

export type ParsedLocation = { street: string; city: string; region: string; postalCode: string };

const US_ZIP_AT_END = /(?:^|[\s,])(\d{5})(?:-\d{4})?\s*$/;
const TOKEN_AT_END = /(?:^|[\s,])([A-Za-z]{2})\.?\s*$/;
const US_STATES = new Set(
  (
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO " +
    "MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY " +
    "DC PR VI GU AS MP"
  ).split(" "),
);
/** State codes that are also street suffixes: "12 Oak Ct", "4 Elm Wy". */
const ALSO_A_STREET_SUFFIX = new Set(["CT", "WY"]);

/**
 * Split the public form's "Service address or ZIP" into the wizard's four
 * address fields, conservatively. The form's placeholder is "78701" and, per
 * the comment above that field, about half of what arrives is exactly that, so
 * the ZIP alone is the common case and has to be right. Anything more is split
 * only where the shape is unambiguous: a trailing ZIP, then a trailing US state
 * code, then commas. Anything left over lands in `street`, which the owner
 * confirms on the Property step anyway. A guess that puts a town in the street
 * box is visible and one tap to fix; a guess that throws a word away is not.
 *
 * Not canvass-order.ts's splitCanvassAddress, deliberately. That one reads a
 * door's address as the autocomplete writes it and only takes a ZIP from after
 * the first comma, so "12345 Main St" is not read as a ZIP. Here the commonest
 * input is a bare "10001", which that rule would file as a street. This
 * parser avoids the same trap differently: a ZIP is only ever the LAST token,
 * and "12345 Main St" ends in "St".
 */
export function parseLeadLocation(raw: string | null | undefined): ParsedLocation {
  const out: ParsedLocation = { street: "", city: "", region: "", postalCode: "" };
  let rest = (raw ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\s,]*\b(United States( of America)?|USA|US)\.?$/i, "");
  if (!rest) return out;

  const zip = US_ZIP_AT_END.exec(rest);
  if (zip) {
    out.postalCode = zip[1];
    rest = rest.slice(0, zip.index).replace(/[\s,]+$/, "");
  }

  const parts = rest
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 0) {
    const last = parts[parts.length - 1];
    const tok = TOKEN_AT_END.exec(last);
    const code = tok?.[1].toUpperCase() ?? "";
    const before = tok ? last.slice(0, tok.index).trim() : "";
    // A lone "TX" with nothing before it is a state only after a comma
    // ("Austin, TX"). And "12 Oak Ct" is a street, not Connecticut: a suffix
    // that is also a state code counts as the state only once a comma has
    // separated the street from it.
    const ambiguous = ALSO_A_STREET_SUFFIX.has(code) && parts.length === 1;
    if (tok && US_STATES.has(code) && !ambiguous && (before || parts.length > 1)) {
      out.region = code;
      if (before) parts[parts.length - 1] = before;
      else parts.pop();
    }
  }

  if (parts.length >= 2) {
    out.city = parts[parts.length - 1];
    out.street = parts.slice(0, -1).join(", ");
  } else if (parts.length === 1) {
    // One piece with no commas. A leading house number makes it a street;
    // otherwise it is a town only if a state or ZIP came after it ("Austin
    // TX", "Brooklyn 11201"), and a street when it stands alone.
    const only = parts[0];
    if (/^\d/.test(only)) out.street = only;
    else if (out.region || out.postalCode) out.city = only;
    else out.street = only;
  }
  return out;
}

// ── Email ────────────────────────────────────────────────────────────────

/** The AI receptionist files SMS callers under a made-up `<digits>@sms.lead`
 *  address because `leads.email` is NOT NULL. It is not a mailbox, and as a
 *  client's primary email it would be sent the welcome email. */
export function isSyntheticLeadEmail(email: string | null | undefined): boolean {
  return !!email && /@sms\.lead$/i.test(email.trim());
}

// ── The mapping ──────────────────────────────────────────────────────────

/**
 * What the wizard starts as when it is opened from a lead.
 *
 * Dogs: one UNNAMED row per dog the lead reported, not "Dog 1", "Dog 2". The
 * database refuses placeholder dog names on purpose (tg_dogs_name_validate), and
 * a tech reading "Dog 2" in a driveway has been told nothing. The wizard prices
 * the plan from the number of rows, so the count survives even if the owner
 * names none of them yet; a row left unnamed is simply not saved as a dog.
 */
export function leadToWizardPrefill(lead: ConvertibleLead): WizardPrefill {
  const loc = parseLeadLocation(lead.location);
  const reported = lead.dog_count ?? 0;
  const rows = Math.min(Math.max(reported, 1), MAX_WIZARD_DOGS);
  const frequency = normalizeLeadFrequency(lead.frequency);

  // Everything the lead said that has no field of its own. The message first,
  // in the prospect's own words; then any fact the fields above could not
  // hold, so nothing the lead told us is lost between the two screens.
  const facts: string[] = [];
  if (lead.company?.trim()) facts.push(`Company: ${lead.company.trim()}`);
  if (lead.frequency?.trim() && !frequency) facts.push(`Asked for: ${lead.frequency.trim()}`);
  if (reported > MAX_WIZARD_DOGS) facts.push(`Dogs reported: ${reported}`);
  const note = [lead.message?.trim() ?? "", facts.join("\n")].filter(Boolean).join("\n\n");

  return {
    displayName: lead.name.trim(),
    primaryEmail: isSyntheticLeadEmail(lead.email) ? "" : lead.email.trim().toLowerCase(),
    primaryPhone: lead.phone?.trim() ?? "",
    street: loc.street,
    city: loc.city,
    region: loc.region,
    postalCode: loc.postalCode,
    dogs: Array.from({ length: rows }, () => ({ ...BLANK_DOG })),
    frequency,
    // Read defensively: a lead row without the column is a lead with no
    // service, never an error.
    serviceId: typeof lead.service_id === "string" && lead.service_id ? lead.service_id : null,
    officeNote: note ? `From the lead:\n${note}` : "",
  };
}
