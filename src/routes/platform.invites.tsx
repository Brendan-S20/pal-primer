import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/platform/invites")({
  component: () => (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Invites</h1>
        <p className="text-sm text-muted-foreground">Pending admin-sent invitations. Resend or revoke here.</p>
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
