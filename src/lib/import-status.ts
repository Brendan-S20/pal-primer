// The words an import's status is shown in.
//
// The badge printed the enum value itself, so a stopped import read
// "cancelled" in lowercase UK spelling next to US copy everywhere else. The
// stored value stays `cancelled` (import_status in the database); only what a
// person reads changes.
import { humanizeEnum } from "@/lib/humanize";

const IMPORT_STATUS_LABEL: Record<string, string> = {
  cancelled: "Canceled",
};

export function importStatusLabel(status: string): string {
  return IMPORT_STATUS_LABEL[status] ?? humanizeEnum(status);
}
