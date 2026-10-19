import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { getOrgBranding, updateOrgBranding } from "@/lib/org.functions";
import { BUSINESS_COUNTRIES } from "@/lib/distance-unit";
import { COUNTRY_NOT_YET, countrySaveOutcome } from "@/lib/org-country-column";

// #496: the country decides whether stop distances read miles or km. Saved
// through updateOrgBranding, the path that already writes the business's
// address, and drawn for manage_settings only, like the time zone beside it on
// Settings > Business. "Other" stores null, and the app then decides from the
// browser's region and the currency (orgDistanceUnit).
//
// The app can deploy before 20261018120000 adds the column. Then the read
// comes back with `country_column_missing` and the write with
// `countryColumnMissing` (org-country-column.ts), and the card says it cannot
// save rather than toasting a save over a value nothing stored.
export function CountryCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getOrgBranding);
  const updateFn = useServerFn(updateOrgBranding);
  const q = useQuery({ queryKey: ["org-branding"], queryFn: () => getFn() });
  const current = q.data?.country ?? null;
  const columnMissing = q.data?.country_column_missing === true;
  // A code the backfill or an earlier save stored that the short list does
  // not name (PR, say) is still offered, so the select shows what is saved.
  const options =
    current && !BUSINESS_COUNTRIES.some((c) => c.value === current)
      ? [...BUSINESS_COUNTRIES, { value: current, label: current }]
      : BUSINESS_COUNTRIES;

  const m = useMutation({
    mutationFn: (country: string | null) => updateFn({ data: { country } }),
    onSuccess: (r) => {
      const { saved, message } = countrySaveOutcome(r);
      if (saved) toast.success(message);
      else toast.error(message);
      qc.invalidateQueries({ queryKey: ["org-branding"] });
      qc.invalidateQueries({ queryKey: ["my-org"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Country</CardTitle>
        <CardDescription>
          Where your business operates. Distances between stops show in miles for the United States
          and in kilometers everywhere else.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Label htmlFor="org-country" className="text-xs">
          Country
        </Label>
        <select
          id="org-country"
          value={current ?? ""}
          disabled={q.isLoading || m.isPending || columnMissing}
          onChange={(e) => m.mutate(e.target.value || null)}
          className="mt-1 h-10 w-full max-w-sm rounded-md border bg-background px-3 text-sm disabled:opacity-60 touch:min-h-11"
        >
          {options.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
          <option value="">Other or not listed</option>
        </select>
        {columnMissing && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {COUNTRY_NOT_YET} It turns on with the next database update.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
