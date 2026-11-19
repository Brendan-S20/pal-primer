import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getTextingReadiness } from "@/lib/texting-readiness.functions";
import type { ProfileStatus, TextingReadiness } from "@/lib/texting-readiness";

const PROFILE_LABEL: Record<string, string> = {
  approved: "Approved",
  in_review: "In review",
  rejected: "Rejected",
  draft: "Draft",
  unknown: "Unknown",
  not_checked: "Not checked",
};

function profileLabel(p: ProfileStatus): string {
  return p.state === "error" ? `Error (${p.errorClass})` : PROFILE_LABEL[p.state];
}

/** Presentational: names and Set/Missing only, never a value. */
export function TextingReadinessView({ data }: { data: TextingReadiness }) {
  return (
    <div className="space-y-3">
      <p className="text-sm" data-testid="readiness-summary">
        {data.summary}
      </p>
      <ul className="space-y-1">
        {data.settings.map((s) => (
          <li key={s.name} className="flex items-center justify-between gap-2 text-sm">
            <span className="font-mono text-xs">
              {s.name}
              {s.required ? "" : " (optional)"}
            </span>
            <Badge variant={s.set ? "default" : s.required ? "destructive" : "outline"}>
              {s.set ? "Set" : "Missing"}
            </Badge>
          </li>
        ))}
      </ul>
      <p className="text-sm">
        Primary customer profile: <span className="font-medium">{profileLabel(data.profile)}</span>
      </p>
    </div>
  );
}

export function TextingReadinessCard() {
  const fn = useServerFn(getTextingReadiness);
  const q = useQuery({ queryKey: ["platform", "texting-readiness"], queryFn: () => fn() });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Texting readiness</CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : q.error || !q.data ? (
          <p className="text-sm text-muted-foreground">Could not load the readiness check.</p>
        ) : (
          <TextingReadinessView data={q.data} />
        )}
      </CardContent>
    </Card>
  );
}
