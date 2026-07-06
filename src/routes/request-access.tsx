import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { submitPlatformSignupRequest } from "@/lib/platform-onboarding.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/request-access")({
  head: () => ({
    meta: [
      { title: "Request access · Scoop CRM" },
      { name: "description", content: "Apply to get access to the Scoop CRM platform for your pet-waste service business." },
    ],
  }),
  component: RequestAccessPage,
});

function RequestAccessPage() {
  const submitFn = useServerFn(submitPlatformSignupRequest);
  const [form, setForm] = useState({
    organization_name: "",
    contact_name: "",
    contact_email: "",
    contact_phone: "",
    website: "",
    approx_client_count: "",
    notes: "",
  });
  const [done, setDone] = useState<null | { dedup: boolean }>(null);

  const submitM = useMutation({
    mutationFn: () => submitFn({
      data: {
        organization_name: form.organization_name,
        contact_name: form.contact_name,
        contact_email: form.contact_email,
        contact_phone: form.contact_phone,
        website: form.website,
        approx_client_count: form.approx_client_count ? Number(form.approx_client_count) : null,
        notes: form.notes,
      },
    }),
    onSuccess: (r) => setDone({ dedup: !!r.dedup }),
    onError: (e) => toast.error((e as Error).message),
  });

  function update<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-xl items-center px-4 py-10">
      <Card className="w-full">
        {done ? (
          <CardContent className="space-y-3 py-10 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
            <div className="text-xl font-semibold">Request received</div>
            <p className="text-sm text-muted-foreground">
              {done.dedup
                ? "You already have a pending request. We'll be in touch shortly."
                : "Thanks — we'll review your application and email you within a few business days."}
            </p>
          </CardContent>
        ) : (
          <>
            <CardHeader>
              <CardTitle>Skip the call — request a workspace</CardTitle>
              <p className="text-sm text-muted-foreground">
                Self-serve signup. Tell us about your business and we'll approve your Scoop CRM workspace,
                usually within one business day. Prefer a walkthrough first?{" "}
                <a href="/contact" className="font-medium underline underline-offset-2">Book a demo</a>.
              </p>
            </CardHeader>
            <CardContent>
              <form
                className="space-y-4"
                onSubmit={(e) => { e.preventDefault(); submitM.mutate(); }}
              >
                <div className="space-y-1">
                  <Label htmlFor="orgn">Business name *</Label>
                  <Input id="orgn" required value={form.organization_name}
                    onChange={(e) => update("organization_name", e.target.value)} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="cn">Your name *</Label>
                    <Input id="cn" required value={form.contact_name}
                      onChange={(e) => update("contact_name", e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ce">Email *</Label>
                    <Input id="ce" type="email" required value={form.contact_email}
                      onChange={(e) => update("contact_email", e.target.value)} />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="cp">Phone</Label>
                    <Input id="cp" value={form.contact_phone}
                      onChange={(e) => update("contact_phone", e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ws">Website</Label>
                    <Input id="ws" value={form.website}
                      onChange={(e) => update("website", e.target.value)} placeholder="acme.com" />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ac">Approx active clients</Label>
                  <Input id="ac" type="number" min="0" value={form.approx_client_count}
                    onChange={(e) => update("approx_client_count", e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="nt">Anything we should know?</Label>
                  <Textarea id="nt" rows={3} value={form.notes}
                    onChange={(e) => update("notes", e.target.value)} />
                </div>
                <Button type="submit" className="w-full" disabled={submitM.isPending}>
                  {submitM.isPending ? "Submitting…" : "Submit request"}
                </Button>
              </form>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
