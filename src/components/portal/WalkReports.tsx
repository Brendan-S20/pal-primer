// The client's walk reports in the portal (#410): who walked, when, for how
// long, pee and poo when the walker recorded them, the walker's note for the
// client, and the photos. The rules for each line live in walk-report.ts,
// the same ones the walk report email uses, so the two say the same thing.
//
// Draws nothing for a client with no completed walks, which is every
// pet-waste client. English: the portal speaks the business's language.

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PortalVisitReport } from "@/components/portal/VisitReport";
import { Footprints } from "lucide-react";
import { portalListWalks, type PortalWalkReport } from "@/lib/portal-walks.functions";
import { usePortalCtx } from "@/lib/portal-ui";

/** The walks query, shared by the reports and the upcoming list's windows. */
export function usePortalWalks() {
  const { token, verified } = usePortalCtx();
  const fn = useServerFn(portalListWalks);
  const q = useQuery({
    queryKey: ["portal", token, "walks"],
    queryFn: () => fn({ data: { token } }),
    enabled: verified,
    staleTime: 30_000,
  });
  return {
    reports: q.data?.reports ?? [],
    upcomingWindows: q.data?.upcomingWindows ?? {},
  };
}

export function WalkReportsSection({ reports }: { reports: PortalWalkReport[] }) {
  if (reports.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
        <Footprints className="h-4 w-4 shrink-0" /> Walk reports
      </h2>
      <ul className="space-y-2">
        {reports.map((r) => (
          <WalkReportCard key={r.visitId} r={r} />
        ))}
      </ul>
    </section>
  );
}

function WalkReportCard({ r }: { r: PortalWalkReport }) {
  return <li className="rounded-md border bg-card p-3">
    <PortalVisitReport report={r} facts={r.walkerFirstName ? [`Walked by ${r.walkerFirstName}`] : []}
      details={[r.peeLine, r.pooLine].filter((v): v is string => !!v)} photoLabel="Walk" />
  </li>;
}
