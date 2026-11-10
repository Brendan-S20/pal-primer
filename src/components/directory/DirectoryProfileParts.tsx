import { MapPin } from "lucide-react";
import {
  coverageLabel,
  directoryLineLabel,
  priceFromLabel,
  type DirectoryProfile,
} from "@/lib/directory";

/** The services a profile lists, each with the price-from its owner
 *  confirmed. A definition list, so a long label wraps inside its row rather
 *  than widening it at 360px. */
export function DirectoryServiceList({ profile }: { profile: DirectoryProfile }) {
  if (!profile.services.length) return null;
  return (
    <ul className="divide-y rounded-lg border">
      {profile.services.map((s, i) => (
        <li
          key={`${s.label}-${i}`}
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-3"
        >
          <div className="min-w-0">
            <p className="font-medium break-words">
              <bdi>{s.label}</bdi>
            </p>
            <p className="text-xs text-muted-foreground">{directoryLineLabel(s.service_line)}</p>
          </div>
          <p className="shrink-0 text-sm font-medium">{priceFromLabel(s)}</p>
        </li>
      ))}
    </ul>
  );
}

/** Where a profile works: city names and ZIP codes, never an address. */
export function DirectoryCoverage({ profile }: { profile: DirectoryProfile }) {
  return (
    <div className="space-y-2">
      <p className="flex min-w-0 items-start gap-1.5 text-sm">
        <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">{coverageLabel(profile)}</span>
      </p>
      {profile.coverage_zips.length ? (
        <p className="text-xs break-words text-muted-foreground" dir="ltr">
          {profile.coverage_zips.join(", ")}
        </p>
      ) : null}
    </div>
  );
}
