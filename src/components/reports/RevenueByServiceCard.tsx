// Revenue by service on /reports (#410): what each service billed in the
// range, so an owner who walks dogs and scoops yards can see each one's
// money. Draws nothing for a business that sells one pet-waste service, so
// that report is unchanged (getRevenueByService answers show: false).
//
// Its own query, not part of getReports: a failure here leaves the rest of
// the page as it was. Office only, so English.

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getRevenueByService } from "@/lib/revenue-by-service.functions";

function fmtMoney(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    (cents ?? 0) / 100,
  );
}

export function RevenueByServiceCard({ from, to }: { from: string; to: string }) {
  const fn = useServerFn(getRevenueByService);
  const q = useQuery({
    queryKey: ["reports", "revenue-by-service", from, to],
    queryFn: () => fn({ data: { from, to } }),
  });
  if (!q.data?.show) return null;
  const rows = q.data.rows;
  const total = rows.reduce((s, r) => s + r.cents, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue by service</CardTitle>
        <p className="text-xs text-muted-foreground">
          Invoice lines before tax, on invoices issued in this range: the same invoices as Billed.
        </p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing billed in this range.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {rows.map((r) => (
                <tr key={r.serviceId ?? "other"} className="border-b last:border-0">
                  <td className="min-w-0 break-words py-2 pr-3">{r.name}</td>
                  <td className="whitespace-nowrap py-2 text-right tabular-nums">
                    {fmtMoney(r.cents)}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="py-2 pr-3 font-medium">Total</td>
                <td className="whitespace-nowrap py-2 text-right font-medium tabular-nums">
                  {fmtMoney(total)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
