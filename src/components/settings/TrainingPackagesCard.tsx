import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  listServicePackages,
  saveServicePackage,
  setServicePackageActive,
} from "@/lib/training-packages.functions";
import { formatServiceMoney, parseDollarsToCents, type Service } from "@/lib/services";
import type { ServicePackage } from "@/lib/training-packages.server";

export const trainingSelectClass =
  "min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm";

export function TrainingPackagesCard({
  services,
  canEdit,
}: {
  services: Service[];
  canEdit: boolean;
}) {
  const list = useServerFn(listServicePackages);
  const saveFn = useServerFn(saveServicePackage);
  const toggleFn = useServerFn(setServicePackageActive);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["service-packages"], queryFn: () => list() });
  const training = services.filter((s) => s.service_line === "training");
  const [form, setForm] = useState<{
    id?: string;
    name: string;
    serviceId: string;
    sessions: string;
    price: string;
    days: string;
  } | null>(null);
  const [error, setError] = useState("");
  // A priced package is half of setup's price step for a trainer (R2-47).
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["service-packages"] });
    qc.invalidateQueries({ queryKey: ["onboarding-status"] });
  };
  const save = useMutation({
    mutationFn: async () => {
      if (!form) return;
      const price = parseDollarsToCents(form.price);
      if (price == null || !Number.isFinite(price))
        throw new Error("Enter a price in dollars and cents.");
      return saveFn({
        data: {
          id: form.id,
          name: form.name,
          serviceId: form.serviceId,
          sessionsCount: Number(form.sessions),
          priceCents: price,
          expiresAfterDays: form.days ? Number(form.days) : null,
        },
      });
    },
    onSuccess: () => {
      setForm(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const toggle = useMutation({
    mutationFn: (p: ServicePackage) => toggleFn({ data: { id: p.id, active: !p.active } }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const open = (p?: ServicePackage) => {
    setError("");
    setForm({
      id: p?.id,
      name: p?.name ?? "",
      serviceId: p?.service_id ?? training[0]?.id ?? "",
      sessions: String(p?.sessions_count ?? 6),
      price: p ? (p.price_cents / 100).toFixed(2) : "",
      days: p ? String(p.expires_after_days ?? "") : "90",
    });
  };
  return (
    <section
      className="space-y-4 rounded-lg border bg-card p-4 sm:p-6"
      data-testid="training-packages-settings"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">Training packages</h3>
          <p className="text-sm text-muted-foreground">
            One price for a set of lessons. Sold packages keep the price and session count from the
            day they were sold. Clients cannot book a training lesson from the portal yet. Sell a
            package and schedule lessons from the client page.
          </p>
        </div>
        {canEdit && (
          <Button className="shrink-0" onClick={() => open()}>
            Add package
          </Button>
        )}
      </div>
      {q.isLoading && <p>Loading packages…</p>}
      {q.error && (
        <p role="alert" className="text-sm text-destructive">
          {q.error.message}
        </p>
      )}
      {q.data?.packages.length === 0 && (
        <p className="text-sm text-muted-foreground">No training packages yet.</p>
      )}
      <ul className="space-y-3">
        {q.data?.packages.map((p) => (
          <li
            key={p.id}
            className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3"
          >
            <div className="min-w-0 flex-1 break-words">
              <p className="font-medium">{p.name}</p>
              <p className="text-sm">
                {training.find((s) => s.id === p.service_id)?.name}, {p.sessions_count} sessions,{" "}
                {formatServiceMoney(p.price_cents)}
              </p>
              <p className="text-sm text-muted-foreground">
                {p.expires_after_days == null
                  ? "Never expires"
                  : `Expires after ${p.expires_after_days} days`}
              </p>
              <Badge variant="secondary">{p.active ? "Active" : "Inactive"}</Badge>
              {!p.active && p.price_cents === 0 && (
                <p className="mt-1 text-sm text-muted-foreground">Set a price to start selling</p>
              )}
            </div>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => open(p)}>
                  Edit
                </Button>
                <Button
                  variant="outline"
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate(p)}
                >
                  {p.active ? "Deactivate" : "Activate"}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <Dialog open={form !== null} onOpenChange={(v) => !v && setForm(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{form?.id ? "Edit package" : "Add package"}</DialogTitle>
            <DialogDescription>
              Save the price and session count, then activate the package to sell it.
            </DialogDescription>
          </DialogHeader>
          {form && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                setError("");
                save.mutate();
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="package-name">Name</Label>
                <Input
                  id="package-name"
                  required
                  maxLength={80}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="package-service">Training service</Label>
                <select
                  id="package-service"
                  required
                  className={trainingSelectClass}
                  value={form.serviceId}
                  onChange={(e) => setForm({ ...form, serviceId: e.target.value })}
                >
                  <option value="">Choose a service</option>
                  {training.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.active ? "" : " (inactive)"}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="package-sessions">Sessions</Label>
                  <Input
                    id="package-sessions"
                    type="number"
                    min={1}
                    max={100}
                    required
                    value={form.sessions}
                    onChange={(e) => setForm({ ...form, sessions: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="package-price">Price ($)</Label>
                  <Input
                    id="package-price"
                    inputMode="decimal"
                    required
                    value={form.price}
                    onChange={(e) => setForm({ ...form, price: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="package-expiry">Expires after (days)</Label>
                <Input
                  id="package-expiry"
                  type="number"
                  min={1}
                  max={730}
                  value={form.days}
                  onChange={(e) => setForm({ ...form, days: e.target.value })}
                />
                <p className="text-sm text-muted-foreground">Leave blank for no expiry.</p>
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save package"}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
