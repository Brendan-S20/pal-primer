import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/platform/announcements")({
  component: () => (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Announcements</h1>
        <p className="text-sm text-muted-foreground">Broadcast messages shown as in-app banners and (optionally) emailed.</p>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Coming later</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Scheduled after billing wires up (step 7 of the rebuild).
        </CardContent>
      </Card>
    </div>
  ),
});
