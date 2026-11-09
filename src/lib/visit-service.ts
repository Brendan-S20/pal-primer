/** A visit knows its service: the service catalog, phase 2 (migrations
 *  20261009230000_a-visit-knows-its-service and
 *  20261009230100_a-walk-takes-as-long-as-the-walk).
 *
 *  Pure functions shared by the plan form, the schedule, My Day and the
 *  route day-fit check, so each reads one copy of:
 *
 *    how long a stop takes             visitServiceMinutes
 *    which services a plan may pick    servicePickerOptions / defaultServiceId
 *    how a stop names its service      visitServiceLabel
 */

import { PET_WASTE_SERVICE_NAME, type Service } from "@/lib/services";
import { SERVICE_LINES, runsPetWaste, type ServiceLine } from "@/lib/service-lines";

/** What the planner assumes when neither the service nor the yard says:
 *  the `8` in `stop_service_min` and in properties.service_duration_min's
 *  default. */
export const DEFAULT_STOP_MINUTES = 8;

/** A minutes value as SQL's COALESCE sees it: present or not. (PostgREST
 *  can hand a numeric back as a string; an unparseable one counts as unset.) */
function minutesOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Minutes on site for a stop. A visit that stored its own length (a groom
 * priced by the pet's size) wins. Otherwise the service's
 * default_duration_min, else the property's service_duration_min, else 8.
 *
 * The same rule as `public.stop_service_min` (two arguments in 20261009230100,
 * three in 20261024100200), which route_day_inputs and apply_route_plan use.
 * Pet-waste services leave their duration NULL on purpose: a cleanup takes as
 * long as the yard.
 */
export function visitServiceMinutes(
  serviceMin: number | string | null | undefined,
  propertyMin: number | string | null | undefined,
  visitMin?: number | string | null,
): number {
  const visit = minutesOrNull(visitMin);
  if (visit != null && visit > 0) return visit;
  return minutesOrNull(serviceMin) ?? minutesOrNull(propertyMin) ?? DEFAULT_STOP_MINUTES;
}

type PickableService = Pick<Service, "id" | "name" | "service_line" | "active">;

/**
 * The services a plan's Service picker lists: the business's active ones, in
 * the Services page's order (by line, then name), plus the plan's CURRENT
 * service even when it has since been deactivated -- otherwise editing an old
 * plan would silently show, and save, a different service.
 */
export function servicePickerOptions<T extends PickableService>(
  services: readonly T[],
  currentId?: string | null,
  lines?: readonly ServiceLine[],
): T[] {
  const lineIndex = (l: string) => {
    const i = (SERVICE_LINES as readonly string[]).indexOf(l);
    return i === -1 ? SERVICE_LINES.length : i;
  };
  return services
    .filter((s) => s.active || s.id === currentId)
    .filter((s) => s.id === currentId || !hidesPetWasteService(s, lines))
    .sort(
      (a, b) =>
        lineIndex(a.service_line) - lineIndex(b.service_line) || a.name.localeCompare(b.name),
    );
}

/** RC3 (F-04, F-05): a business that does not run pet waste still has the
 *  "Pet waste removal" every business is seeded with, often still active (it
 *  was made while the column said {pet_waste}). It is not offered in that
 *  business's pickers and never starts one. Hiding only: the row is
 *  untouched, a plan that already has it keeps it (`currentId`), and with no
 *  `lines` (an answer nobody read) nothing is hidden, so an unreadable
 *  answer is still pet waste. */
export function hidesPetWasteService(
  s: Pick<PickableService, "service_line">,
  lines: readonly ServiceLine[] | undefined,
): boolean {
  return !!lines && s.service_line === "pet_waste" && !runsPetWaste(lines);
}

/**
 * What a NEW plan's picker starts on: the business's pet-waste removal when
 * it sells it (the seeded name first, then any active pet-waste service it was
 * renamed to), else the first active service. Given `lines` without pet
 * waste, its first other service (hidesPetWasteService). Null when there is
 * nothing to pick, in which case the server leaves service_id unset and the
 * database gives the plan the business's default (ensure_default_services).
 */
export function defaultServiceId(
  services: readonly PickableService[],
  lines?: readonly ServiceLine[],
): string | null {
  const active = services.filter((s) => s.active && !hidesPetWasteService(s, lines));
  const named = active.find(
    (s) => s.name.trim().toLowerCase() === PET_WASTE_SERVICE_NAME.toLowerCase(),
  );
  if (named) return named.id;
  const petWaste = active.find((s) => s.service_line === "pet_waste");
  if (petWaste) return petWaste.id;
  return servicePickerOptions(active)[0]?.id ?? null;
}

/** The service a visit row carries, as the selects embed it. */
export type VisitServiceRef = {
  name?: string | null;
  service_line?: string | null;
  default_duration_min?: number | null;
} | null;

function isServiceLine(v: unknown): v is ServiceLine {
  return typeof v === "string" && (SERVICE_LINES as readonly string[]).includes(v);
}

/**
 * How a tech's card names a stop's service: the LINE, which the app
 * translates (`serviceLine.<line>`), and the business's own NAME, which it
 * does not -- it is the business's text, shown in a <bdi>. The name is left
 * out when it is the seeded "Pet waste removal", because that one is ours and
 * the translated line already says it.
 */
export function visitServiceLabel(service: VisitServiceRef | undefined): {
  line: ServiceLine;
  ownName: string | null;
} | null {
  if (!service) return null;
  const line: ServiceLine = isServiceLine(service.service_line) ? service.service_line : "other";
  const name = service.name?.trim() || null;
  const ownName = name && name.toLowerCase() !== PET_WASTE_SERVICE_NAME.toLowerCase() ? name : null;
  return { line, ownName };
}

/** A plan card's title. A plan of the seeded pet-waste service (or one from
 *  before plans had a service) reads as it always has; any other names the
 *  business's service: "Recurring · 30-minute walk". */
export function planTitle(
  frequency: string | null | undefined,
  service: VisitServiceRef | undefined,
): string {
  const oneTime = frequency === "one_time";
  const label = visitServiceLabel(service);
  if (!label?.ownName)
    return oneTime ? "One-time pet waste removal" : "Recurring pet waste removal";
  return `${oneTime ? "One-time" : "Recurring"} · ${label.ownName}`;
}

/** True when the visits on screen are not all one service: what decides
 *  whether a dense chip spends a line on it (a board where every stop is
 *  "Pet waste removal" learns nothing from reading it forty times). */
export function servicesVary(visits: readonly { service_id?: string | null }[]): boolean {
  const seen = new Set<string>();
  for (const v of visits) {
    if (v.service_id) seen.add(v.service_id);
    if (seen.size > 1) return true;
  }
  return false;
}
