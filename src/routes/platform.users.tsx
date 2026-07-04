import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/platform/users")({
  component: () => (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">Global user directory across every tenant.</p>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Coming later</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Scheduled after billing (step 9 of the rebuild).
        </CardContent>
      </Card>
    </div>
  ),
});
