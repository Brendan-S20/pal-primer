import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOrgServices } from "@/components/client-detail/ServicePicker";
import { setSetupWalkPrices } from "@/lib/setup-walk-prices.functions";
import { setupWalkFields, setupWalkPricesProblem, walkPriceCents } from "@/lib/setup-walk-prices";

// ── /setup, step 2: what a walk costs (#769) ──────────────────────────────
//
// The walking part of the price step used to be a button to Settings,
// Services. An owner who did not follow it finished setup with every walk
// "No price yet", and the new-client Plan step could not quote one. So the
// 30- and 60-minute walks are priced HERE, and the drop-in beside them,
// marked optional.
//
// Reads and refreshes the same query Settings → Services and the new-client
// service picker read (SERVICES_QUERY_KEY, under ["services"]), so the price
// saved here is the price those screens show without a reload.
//
// Office-only (owner, office manager), so English.

export function WalkPricesForm({
  done,
  onSaved,
  saveLabel = "Save and continue",
}: {
  done: boolean;
  onSaved: () => void;
  saveLabel?: string;
}) {
  const qc = useQueryClient();
  const saveFn = useServerFn(setSetupWalkPrices);
  const { services, isLoading } = useOrgServices();
  const walks = services.filter((s) => s.service_line === "dog_walking" && s.active);
  const fields = setupWalkFields(walks);
  // null = untouched: the field shows what is stored.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const valueOf = (id: string, cents: number | null) =>
    typed[id] ?? (cents != null && cents > 0 ? (cents / 100).toFixed(2) : "");

  const m = useMutation({
    mutationFn: async () => {
      const rows = fields.map(({ walk, required }) => ({
        id: walk.id,
        name: walk.name,
        required,
        cents: walkPriceCents(valueOf(walk.id, walk.base_price_cents)),
      }));
      const problem = setupWalkPricesProblem(rows);
      if (problem) throw new Error(problem);
      await saveFn({ data: { prices: rows.map(({ id, cents }) => ({ id, cents })) } });
    },
    onSuccess: async () => {
      toast.success("Walk prices saved");
      setTyped({});
      await qc.invalidateQueries({ queryKey: ["services"] });
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading your walks…</p>;

  if (fields.length === 0) {
    return (
      <p className="text-sm">
        You have no walks to price yet. Add one in{" "}
        <Link to="/settings/services" className="underline">
          Settings, Services
        </Link>
        .
      </p>
    );
  }

  return (
    <form
      className="space-y-4"
      data-setup-walk-prices
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(({ walk, required }) => (
          <div key={walk.id} className="min-w-0 space-y-1.5">
            <Label htmlFor={`setup-walk-${walk.id}`}>
              <bdi>{walk.name}</bdi> ($){required ? "" : ", optional"}
            </Label>
            <Input
              id={`setup-walk-${walk.id}`}
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              required={required}
              value={valueOf(walk.id, walk.base_price_cents)}
              onChange={(e) => setTyped((t) => ({ ...t, [walk.id]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        A walk left blank is not offered to clients until it has a price. Extra-dog charges, lengths
        and new walks are in{" "}
        <Link to="/settings/services" className="underline">
          Settings, Services
        </Link>
        .
      </p>
      <Button type="submit" disabled={m.isPending} data-setup-action="save-walks">
        {m.isPending ? "Saving…" : done ? "Save walk prices" : saveLabel}
      </Button>
    </form>
  );
}
