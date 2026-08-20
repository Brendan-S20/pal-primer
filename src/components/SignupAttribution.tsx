import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Megaphone } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getSignupAttribution } from "@/lib/platform-referrals.functions";
import { UTM_KEYS, type AttributionRow, type UtmKey } from "@/lib/signup-attribution.report";

// The reader `organizations.signup_utm` never had — see
// signup-attribution.report.ts for the reasoning behind surfacing rather than
// deleting.
//
// It sits on /platform/referrals because that page already answers "where did
// this tenant come from" for the referral half. Splitting paid and referred
// acquisition across two screens would mean nobody ever sees the two numbers
// side by side, which is the comparison worth making.

const KEY_LABEL: Record<UtmKey, string> = {
  utm_source: "Source",
  utm_medium: "Medium",
  utm_campaign: "Campaign",
  utm_term: "Term",
  utm_content: "Content",
};

export function SignupAttribution() {
  const fn = useServerFn(getSignupAttribution);
  const [key, setKey] = useState<UtmKey>("utm_source");
  const q = useQuery({ queryKey: ["platform", "signup-attribution"], queryFn: () => fn() });

  if (q.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where signups came from</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Loading…</CardContent>
      </Card>
    );
  }
  if (!q.data) return null;

  const rows: AttributionRow[] = (q.data.byKey as Record<string, AttributionRow[]>)[key] ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="h-4 w-4" /> Where signups came from
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {/* Conversions, not signups, are the point. A campaign with forty
                signups and no conversions is one to stop funding, and a
                signup count on its own cannot say that. */}
            Counted by paying customers produced, not signups. A campaign that brings people who
            never pay should sort below one that brings fewer who do.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {UTM_KEYS.map((k) => (
            <button
              key={k}
              onClick={() => setKey(k)}
              className={`rounded px-2 py-1 text-xs transition ${
                key === k
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {KEY_LABEL[k]}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {!q.data.anyAttribution ? (
          // Deliberately not "no data". Nothing has come through a tagged link
          // yet, which is a different fact and the only one that tells someone
          // what to do about it.
          <p className="text-sm text-muted-foreground">
            No signup has arrived through a tagged link yet. Add{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              ?utm_source=…&amp;utm_campaign=…
            </code>{" "}
            to the links you publish and they will be attributed here. All {q.data.totalOrgs}{" "}
            organizations so far signed up directly.
          </p>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs uppercase text-muted-foreground">
                  <th className="py-2 text-left font-medium">{KEY_LABEL[key]}</th>
                  <th className="py-2 text-right font-medium">Signups</th>
                  <th className="py-2 text-right font-medium">Paying</th>
                  <th className="py-2 text-right font-medium">Rate</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.value ?? "__none__"} className="border-b last:border-0">
                    <td className="py-2">
                      {r.value ?? (
                        <span className="text-muted-foreground">Untagged (direct)</span>
                      )}
                    </td>
                    <td className="py-2 text-right">{r.signups}</td>
                    <td className="py-2 text-right font-medium">{r.converted}</td>
                    <td className="py-2 text-right">
                      {r.conversionPercent === null ? (
                        "—"
                      ) : (
                        <Badge variant={r.converted > 0 ? "default" : "outline"}>
                          {r.conversionPercent}%
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
