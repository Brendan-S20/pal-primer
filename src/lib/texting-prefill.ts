// #970: what Settings → Texting starts from, so an owner is not asked to
// type again what Business settings already holds.
//
// Prefilled: the business name (as "Doing business as", never as the legal
// name), its address, phone and email, and the owner's name and email as
// authorized contact 1. NOT prefilled: the legal name. Carriers reject a
// filing whose legal name does not match the EIN letter, and the name a
// business trades under is very often not the name on that letter, so a
// legal name copied from the DBA is a rejection we would have typed for them.
//
// Pure, so the form and its tests read the same answer.

import type { RegistrationContact } from "@/lib/texting-registration";

export type TextingPrefill = {
  /** organizations.name: the name the business trades under. */
  businessName: string;
  /** organizations.contact_email */
  email: string;
  /** organizations.contact_phone */
  phone: string;
  /** organizations.contact_address, one line as Business settings keeps it. */
  address: string;
  /** The owner's staff row: display name, email and phone. */
  owner: { name: string; email: string; phone: string };
};

export const NO_PREFILL: TextingPrefill = {
  businessName: "",
  email: "",
  phone: "",
  address: "",
  owner: { name: "", email: "", phone: "" },
};

/** The suggestions as Settings reads them. A response from before #970 (a
 *  half-done deploy, a cached query) has no address and no owner; those start
 *  blank instead of taking the page down. */
export function withPrefillDefaults(
  s:
    | (Partial<Omit<TextingPrefill, "owner">> & { owner?: Partial<TextingPrefill["owner"]> })
    | null
    | undefined,
): TextingPrefill {
  return { ...NO_PREFILL, ...s, owner: { ...NO_PREFILL.owner, ...s?.owner } };
}

export type AddressParts = {
  street: string;
  street2: string;
  city: string;
  region: string;
  postal_code: string;
};

const STATES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

/**
 * Business settings keeps the address as one line ("18000 W Eight Mile Rd,
 * Suite 2400, Southfield, MI 48075, USA"); the filing wants it in parts.
 * A line that does not end in a state and ZIP is not guessed at: it goes in
 * Street whole, and the owner splits it.
 */
export function splitUsAddress(raw: string | null | undefined): AddressParts {
  const empty: AddressParts = { street: "", street2: "", city: "", region: "", postal_code: "" };
  const parts = (raw ?? "")
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return empty;
  if (/^(usa|us|u\.s\.a?\.?|united states( of america)?)$/i.test(parts[parts.length - 1]))
    parts.pop();
  const whole = { ...empty, street: parts.join(", ") };
  if (parts.length < 3) return whole;

  let tail = parts.pop()!;
  let zip = "";
  const zipOnly = /^(\d{5}(?:-\d{4})?)$/.exec(tail);
  if (zipOnly) {
    // "…, Southfield, MI, 48075"
    zip = zipOnly[1];
    tail = parts.pop() ?? "";
  }
  const m = /^(.*?)[\s.]*(\d{5}(?:-\d{4})?)?$/.exec(tail);
  const stateText = (m?.[1] ?? "").trim().replace(/\.$/, "");
  zip ||= m?.[2] ?? "";
  const region = /^[A-Za-z]{2}$/.test(stateText)
    ? stateText.toUpperCase()
    : (STATES[stateText.toLowerCase()] ?? "");
  if (!region || !zip || parts.length < 2) return whole;

  const city = parts.pop()!;
  const [street, ...rest] = parts;
  return { street, street2: rest.join(", "), city, region, postal_code: zip };
}

/** "Devin Abernathy-Kowalczyk" → Devin / Abernathy-Kowalczyk. One word is a
 *  first name; the owner adds the rest. */
export function splitName(display: string | null | undefined): {
  first_name: string;
  last_name: string;
} {
  const words = (display ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { first_name: "", last_name: "" };
  return { first_name: words[0], last_name: words.slice(1).join(" ") };
}

/** Authorized contact 1, from the owner. Title "Owner", because it is. */
export function ownerContact(p: TextingPrefill): RegistrationContact {
  return {
    ...splitName(p.owner.name),
    title: p.owner.name || p.owner.email ? "Owner" : "",
    email: p.owner.email,
    phone: p.owner.phone,
  };
}

/** Whether a contact has anything typed in it at all. */
export function contactIsBlank(c: Partial<Record<keyof RegistrationContact, string | null>>) {
  return !Object.values(c).some((v) => typeof v === "string" && v.trim() !== "");
}

/**
 * What is filed: contact 1 always, contact 2 only when something was typed
 * in it. A half-filled second contact is kept, so the check names what it is
 * missing rather than dropping a person the owner meant to add.
 */
export function contactsToFile<T extends Partial<Record<keyof RegistrationContact, string | null>>>(
  contacts: readonly T[],
): T[] {
  return contacts.filter((c, i) => i === 0 || !contactIsBlank(c));
}
