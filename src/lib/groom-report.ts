// A groom's report as the client reads it in the portal (#412): who groomed,
// what was booked, the add-ons that were actually billed, the groomer's note
// for the client, and the before and after photos. Pure, so the rules are
// tested without a database; the reads are in portal-groom-reports.functions.ts.

import { walkerFirstName } from "@/lib/walk-report";

export type GroomReportPhoto = { url: string; kind: string };

export type PortalGroomReport = {
  visitId: string;
  day: string;
  serviceName: string | null;
  groomerFirstName: string | null;
  /** What was booked: "Full groom for Biscuit (L) + Teeth brushing". */
  summary: string | null;
  /** The add-ons billed on this groom, booked or added on the day. An add-on
   *  the groomer marked not done was never charged, so it is not here. */
  addonsDone: string[];
  reportNote: string | null;
  before: string[];
  after: string[];
};

/** The photo kinds a groom report draws. "completion" is the finished groom:
 *  the client reads it as After. Issue and gate photos are not part of a
 *  groom's report: an issue photo is for the office to raise with the client
 *  in words, and a groom has no gate. */
export const GROOM_REPORT_PHOTO_KINDS = { before: "before", after: "completion" } as const;

export function splitGroomPhotos(photos: readonly GroomReportPhoto[]): {
  before: string[];
  after: string[];
} {
  return {
    before: photos.filter((p) => p.kind === GROOM_REPORT_PHOTO_KINDS.before).map((p) => p.url),
    after: photos.filter((p) => p.kind === GROOM_REPORT_PHOTO_KINDS.after).map((p) => p.url),
  };
}

/** One line per add-on billed on the visit. A voided charge (the office took
 *  it off, or the groom was later marked missed) is left out; two charges for
 *  the same add-on are listed once with their quantities added. */
export function groomAddonsBilled(
  charges: readonly {
    description: string | null;
    quantity: number | null;
    status: string | null;
  }[],
): string[] {
  const totals = new Map<string, number>();
  for (const c of charges) {
    if (c.status === "voided") continue;
    const name = (c.description ?? "").trim();
    if (!name) continue;
    totals.set(name, (totals.get(name) ?? 0) + Math.max(1, c.quantity ?? 1));
  }
  return [...totals].map(([name, qty]) => (qty > 1 ? `${name} x${qty}` : name));
}

export function groomReport(input: {
  visitId: string;
  day: string;
  serviceName: string | null;
  groomerName: string | null;
  summary: string | null;
  reportNote: string | null;
  charges: readonly {
    description: string | null;
    quantity: number | null;
    status: string | null;
  }[];
  photos: readonly GroomReportPhoto[];
}): PortalGroomReport {
  const { before, after } = splitGroomPhotos(input.photos);
  const note = input.reportNote?.trim();
  const summary = input.summary?.trim();
  return {
    visitId: input.visitId,
    day: input.day,
    serviceName: input.serviceName,
    groomerFirstName: walkerFirstName(input.groomerName),
    summary: summary || null,
    addonsDone: groomAddonsBilled(input.charges),
    reportNote: note || null,
    before,
    after,
  };
}
