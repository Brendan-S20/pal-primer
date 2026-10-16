/** How a walker gets into a home (#410). Pure, so the office drawer, My Day
 *  and the tests read one copy of the rules.
 *
 *  properties.access_method (migration 20261015210000) takes exactly these
 *  values; properties_access_method_check is the database's copy. */

import type { ServiceLine } from "@/lib/service-lines";

export const ACCESS_METHODS = ["key", "lockbox", "code", "garage", "person_home"] as const;
export type AccessMethod = (typeof ACCESS_METHODS)[number];

/** Office labels. English on purpose: the property drawer is an office screen.
 *  My Day reads the same codes through t("walk.access.<code>"). */
export const ACCESS_METHOD_LABEL: Record<AccessMethod, string> = {
  key: "Key",
  lockbox: "Lock box",
  code: "Door code",
  garage: "Garage code",
  person_home: "Someone is home",
};

export const KEY_TAG_MAX = 40;

export function isAccessMethod(v: unknown): v is AccessMethod {
  return typeof v === "string" && (ACCESS_METHODS as readonly string[]).includes(v);
}

export type WalkAccessFields = {
  access_method?: string | null;
  key_held?: boolean | null;
  key_tag?: string | null;
};

/** Whether a property already says anything about walker access. */
export function hasWalkAccess(p: WalkAccessFields | null | undefined): boolean {
  return !!p && (isAccessMethod(p.access_method) || !!p.key_held || !!p.key_tag?.trim());
}

/** The office sees the walker-access fields when the business runs dog walking,
 *  or when this property already has a value (so nothing saved is hidden). A
 *  pet-waste-only business with nothing recorded sees the drawer as before. */
export function showsWalkAccess(
  lines: readonly ServiceLine[],
  p: WalkAccessFields | null | undefined,
): boolean {
  return lines.includes("dog_walking") || hasWalkAccess(p);
}

export type WalkAccessForm = {
  accessMethod: AccessMethod | "";
  keyHeld: boolean;
  keyTag: string;
  lockBoxCode: string;
  keyLocation: string;
};

/** The gate code under the same save rule as the walker-access codes. It is
 *  on every property drawer, so it has its own helper. */
export type GateCodeForm = { gateCode: string };

/** What the property drawer sends for the gate code on save.
 *
 *  The gate code comes from property_access_codes, like the lock box code.
 *  When that call failed or refused, the field opens blank, and sending the
 *  blank would wipe what is stored. So the gate code goes out only when the
 *  user changed it. Left alone, it is omitted. Cleared after a load, it is
 *  sent as null. */
export function gateCodeSave(initial: GateCodeForm, form: GateCodeForm): { gateCode?: string | null } {
  if (form.gateCode.trim() === initial.gateCode.trim()) return {};
  return { gateCode: form.gateCode.trim() || null };
}

/** What the property drawer sends for walker access on save.
 *
 *  The lock box code, key location and key tag come from
 *  property_access_codes, which can fail or refuse. When it did, the form
 *  shows them blank, and sending that blank would wipe what is stored. So
 *  each of the three goes out only when the user changed it from what the
 *  form opened with. A field left alone is omitted, and the server leaves
 *  the column as it is. A field the user cleared after a load is sent as
 *  null, which clears it. The gate code follows the same rule
 *  (gateCodeSave), and is sent with or without the walker-access fields.
 *
 *  Turning "key held" off in this edit still clears the key tag. */
export function walkAccessSave(initial: WalkAccessForm, form: WalkAccessForm) {
  const changed = (k: "keyTag" | "lockBoxCode" | "keyLocation") =>
    form[k].trim() !== initial[k].trim();
  const out: {
    accessMethod: AccessMethod | null;
    keyHeld: boolean;
    keyTag?: string | null;
    lockBoxCode?: string | null;
    keyLocation?: string | null;
  } = {
    accessMethod: form.accessMethod || null,
    keyHeld: form.keyHeld,
  };
  if (initial.keyHeld && !form.keyHeld) out.keyTag = null;
  else if (form.keyHeld && changed("keyTag")) out.keyTag = form.keyTag.trim() || null;
  if (changed("lockBoxCode")) out.lockBoxCode = form.lockBoxCode.trim() || null;
  if (changed("keyLocation")) out.keyLocation = form.keyLocation.trim() || null;
  return out;
}

/** Trimmed key tag, or null. Never longer than the column allows. */
export function cleanKeyTag(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t.slice(0, KEY_TAG_MAX) : null;
}
