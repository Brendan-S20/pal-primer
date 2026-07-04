import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/platform/coupons")({
  component: () => (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Coupons</h1>
        <p className="text-sm text-muted-foreground">Discount codes mirrored to Stripe.</p>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Coming next</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Ships with plans in step 5 of the rebuild.
        </CardContent>
      </Card>
    </div>
  ),
});
