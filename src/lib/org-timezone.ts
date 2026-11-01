/**
 * Which time zone is a new business in? (#654, F-24 / native-r2-07)
 *
 * The audit found setup on Central six times out of six, including on a phone
 * set to America/Detroit. Three causes, each fixed here or at its call site:
 *
 *   1. The main signup form (get-started) never sent a zone, so the org kept
 *      the column default, America/Chicago. It now sends `deviceTimezone()`.
 *   2. The setup step showed `saved ?? Chicago`, and the saved value WAS that
 *      column default, so nothing ever looked at the device. It now asks
 *      `suggestSetupTimezone`.
 *   3. America/Detroit was not an option, so even a correct value showed as
 *      the first option in the list. The list has it now, and
 *      `timezoneOptions` keeps any stored zone selectable.
 *
 * On a native build the web view's `Intl` reports the phone's own zone, so
 * the same call covers the iOS and Android setup.
 */
import { DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";
import { US_TIMEZONES } from "@/lib/route-window";

/** The zone the browser or phone is set to, or undefined when it cannot be
 *  read (server render, hardened browser). */
export function deviceTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A zone a US business plausibly runs in. "UTC" or "Europe/London" from a
 *  laptop that was set up abroad is not a guess worth preselecting. */
function isUsZone(tz: string): boolean {
  return tz.startsWith("America/") || tz === "Pacific/Honolulu";
}

/** The zone most of each state's people live in. Split states take the zone
 *  of their largest city; the owner can still change it. */
const STATE_ZONE: Record<string, string> = {
  AL: "America/Chicago",
  AK: "America/Anchorage",
  AZ: "America/Phoenix",
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DC: "America/New_York",
  DE: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  ID: "America/Boise",
  IL: "America/Chicago",
  IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago",
  KS: "America/Chicago",
  KY: "America/New_York",
  LA: "America/Chicago",
  ME: "America/New_York",
  MD: "America/New_York",
  MA: "America/New_York",
  MI: "America/Detroit",
  MN: "America/Chicago",
  MS: "America/Chicago",
  MO: "America/Chicago",
  MT: "America/Denver",
  NE: "America/Chicago",
  NV: "America/Los_Angeles",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NY: "America/New_York",
  NC: "America/New_York",
  ND: "America/Chicago",
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Chicago",
  TN: "America/Chicago",
  TX: "America/Chicago",
  UT: "America/Denver",
  VT: "America/New_York",
  VA: "America/New_York",
  WA: "America/Los_Angeles",
  WV: "America/New_York",
  WI: "America/Chicago",
  WY: "America/Denver",
};

/** "123 Main St, Portland, OR 97201" -> "America/Los_Angeles". Reads the last
 *  two-letter state code that is followed by a ZIP or ends the address. */
export function timezoneFromUsAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const re =
    /(?:^|[\s,])([A-Za-z]{2})(?=\s+\d{5}(?:-\d{4})?\b|\s*,?\s*(?:US|USA|United States)?\s*$)/g;
  let state: string | null = null;
  for (const m of address.matchAll(re)) state = m[1].toUpperCase();
  return state ? (STATE_ZONE[state] ?? null) : null;
}

/** What the setup step preselects.
 *
 *  A stored zone that is not the column default was chosen by somebody (the
 *  signup form sent it, or the owner picked it) and is kept. Otherwise the
 *  device's zone, when it is a US zone; otherwise the business address's;
 *  otherwise whatever is stored, or the default. */
export function suggestSetupTimezone(args: {
  saved: string | null | undefined;
  device?: string | null;
  address?: string | null;
}): string {
  const { saved, device, address } = args;
  if (isValidTimezone(saved) && saved !== DEFAULT_ORG_TIMEZONE) return saved;
  if (isValidTimezone(device) && isUsZone(device)) return device;
  const fromAddress = timezoneFromUsAddress(address);
  if (fromAddress) return fromAddress;
  return isValidTimezone(saved) ? saved : DEFAULT_ORG_TIMEZONE;
}

/** The select's options, with the current zone kept selectable when it is
 *  not one of the common ones (a device in America/Kentucky/Louisville). */
export function timezoneOptions(
  current: string | null | undefined,
): Array<{ value: string; label: string }> {
  if (!current || US_TIMEZONES.some((t) => t.value === current)) return US_TIMEZONES;
  return [...US_TIMEZONES, { value: current, label: current.replace(/_/g, " ") }];
}
