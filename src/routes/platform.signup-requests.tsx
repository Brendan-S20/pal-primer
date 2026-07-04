import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/platform/signup-requests")({
  component: () => (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Signup requests</h1>
        <p className="text-sm text-muted-foreground">
          Applications from the public request-access form. Approve to auto-create the org and email an owner invite.
        </p>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Coming next</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Ships with the invite &amp; onboarding pass (step 4 of the rebuild).
        </CardContent>
      </Card>
    </div>
  ),
});
