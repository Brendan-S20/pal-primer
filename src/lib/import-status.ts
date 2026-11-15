// The words an import's status is shown in.
//
// The badge printed the enum value itself, so a stopped import read
// "cancelled" in lowercase UK spelling next to US copy everywhere else. The
// stored value stays `cancelled` (import_status in the database); only what a
// person reads changes.
import { humanizeEnum } from "@/lib/humanize";

const IMPORT_STATUS_LABEL: Record<string, string> = {
  cancelled: "Canceled",
  undone: "Undone",
};

export function importStatusLabel(status: string): string {
  return IMPORT_STATUS_LABEL[status] ?? humanizeEnum(status);
}

/** What the Errors tile on an import's page shows (#926). */
export type ImportErrorsTile = { kind: "count"; count: number } | { kind: "stopped" };

/**
 * A previewing or committed import counts the rows the preview found errors
 * in, as it always has. A FAILED import counts every row that did not go in:
 * the commit's own failures plus the preview's errors. And a failed import
 * with no row to blame (it stopped, say after the plan was created) says
 * "Stopped" rather than "0": a zero there reads as a clean import, and no
 * number is made up to fill it.
 */
export function importErrorsTile(status: string, stats: unknown): ImportErrorsTile {
  const s = (stats ?? {}) as Record<string, unknown>;
  const n = (k: string) =>
    typeof s[k] === "number" && Number.isFinite(s[k]) ? (s[k] as number) : 0;
  if (status !== "failed") return { kind: "count", count: n("errors") };
  const failed = n("failed") + n("errors");
  return failed > 0 ? { kind: "count", count: failed } : { kind: "stopped" };
}
