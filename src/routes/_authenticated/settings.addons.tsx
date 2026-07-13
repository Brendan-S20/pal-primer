import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { listAddonServices, upsertAddonService } from "@/lib/addons.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings/addons")({
  component: AddonsCatalog,
});

const FREQS = ["", "weekly", "biweekly", "monthly", "quarterly", "yearly"];

function AddonsCatalog() {
  const qc = useQueryClient();
  const list = useServerFn(listAddonServices);
  const upsert = useServerFn(upsertAddonService);
  const { data } = useQuery({
    queryKey: ["addon-services", "all"],
    queryFn: () => list({ data: { includeInactive: true } }),
  });

  const services: any[] = data?.services ?? [];

  const upsertMut = useMutation({
    mutationFn: (v: any) => upsert({ data: v }),
    onSuccess: () => {
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["addon-services"] });
      qc.invalidateQueries({ queryKey: ["addon-services", "all"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [draft, setDraft] = useState({
    code: "",
    name: "",
    // Keep the price as raw string state while the user is typing —
    // the previous version rebuilt the input's value from
    // `(unit_price_cents / 100).toFixed(2)` on every keystroke, which
    // clobbered mid-entry input ("10.00" landed as "1.00" because the
    // controlled value was re-forced to a formatted 2-decimal string
    // before the user finished typing).
    unit_price: "0.00",
    kind: "one_time" as "one_time" | "recurring",
    default_frequency: "" as string,
    description: "",
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Add-on services</h1>
        <p className="text-sm text-muted-foreground">
          Cross-sells your team can bill from the office or in the field.
        </p>
      </div>

      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-medium">New service</h2>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.code || !draft.name) return;
            const cents = Math.round(parseFloat(draft.unit_price || "0") * 100);
            upsertMut.mutate({
              code: draft.code,
              name: draft.name,
              unit_price_cents: Number.isFinite(cents) ? cents : 0,
              kind: draft.kind,
              default_frequency: draft.default_frequency || null,
              description: draft.description || null,
            });
            setDraft({ code: "", name: "", unit_price: "0.00", kind: "one_time", default_frequency: "", description: "" });
          }}
        >
          <div className="sm:col-span-2">
            <Label>Code</Label>
            <Input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder="deodorize" />
          </div>
          <div className="sm:col-span-3">
            <Label>Name</Label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Yard deodorize" />
          </div>
          <div className="sm:col-span-1">
            <Label>Price ($)</Label>
            <Input type="number" step="0.01" min="0"
              value={draft.unit_price}
              onChange={(e) => setDraft({ ...draft, unit_price: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <Label>Type</Label>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as any })}
            >
              <option value="one_time">One-time</option>
              <option value="recurring">Recurring</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <Label>Default frequency</Label>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={draft.default_frequency}
              onChange={(e) => setDraft({ ...draft, default_frequency: e.target.value })}
            >
              {FREQS.map((f) => <option key={f} value={f}>{f || "—"}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2 flex items-end">
            <Button type="submit" disabled={upsertMut.isPending}>Add service</Button>
          </div>
        </form>
      </section>

      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-medium">Catalog</h2>
        {services.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No services yet.</p>
        ) : (
          <ul className="mt-3 divide-y">
            {services.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <div className="text-sm font-medium">
                    {s.name}
                    <span className="ml-2 text-xs text-muted-foreground">({s.code})</span>
                    {!s.active && <Badge variant="outline" className="ml-2">inactive</Badge>}
                    <Badge variant="secondary" className="ml-2 text-[10px]">{s.kind}</Badge>
                  </div>
                  {s.description && <div className="text-xs text-muted-foreground">{s.description}</div>}
                </div>
                <div className="flex items-center gap-3">
                  <Input
                    type="number" step="0.01" min="0" className="h-8 w-24"
                    defaultValue={(s.unit_price_cents / 100).toFixed(2)}
                    onBlur={(e) => {
                      const cents = Math.round(parseFloat(e.target.value || "0") * 100);
                      if (cents !== s.unit_price_cents) {
                        upsertMut.mutate({ ...s, unit_price_cents: cents });
                      }
                    }}
                  />
                  <Button size="sm" variant="outline"
                    onClick={() => upsertMut.mutate({ ...s, active: !s.active })}>
                    {s.active ? "Deactivate" : "Activate"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
