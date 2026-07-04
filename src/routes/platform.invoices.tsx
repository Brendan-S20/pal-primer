import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/platform/invoices")({
  component: () => (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">SaaS invoices</h1>
        <p className="text-sm text-muted-foreground">Invoices we send to our tenants for their subscription.</p>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Coming next</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Populates once the Stripe webhook is wired (step 6 of the rebuild).
        </CardContent>
      </Card>
    </div>
  ),
});
