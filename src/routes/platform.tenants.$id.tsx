import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/platform/tenants/$id")({
  component: () => (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Tenant detail</h1>
        <p className="text-sm text-muted-foreground">
          7-subtab workspace (Overview / Users / Billing / Invoices / Feature flags / Notes / Audit).
        </p>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Coming next</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Wires up in step 3 of the rebuild (right after this one).
        </CardContent>
      </Card>
    </div>
  ),
});
