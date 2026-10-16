import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  COAT_LABEL,
  COAT_TYPES,
  PET_SIZES,
  PET_SIZE_LABEL,
  type CoatType,
  type PetSize,
} from "@/lib/groom";
import {
  listServiceSizeRules,
  upsertServiceSizeRule,
  deleteServiceSizeRule,
  type ServiceSizeRule,
} from "@/lib/groom.functions";
import { centsToDollarInput, parseDollarsToCents } from "@/lib/services";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ServiceSizeRulesEditor({
  serviceId,
  serviceLine,
}: {
  serviceId: string;
  serviceLine: string;
}) {
  if (serviceLine !== "mobile_grooming") return null;
  return <GroomSizeRules serviceId={serviceId} />;
}

function GroomSizeRules({ serviceId }: { serviceId: string }) {
  const list = useServerFn(listServiceSizeRules);
  const qc = useQueryClient();
  const key = ["service-size-rules", serviceId];
  const query = useQuery({ queryKey: key, queryFn: () => list({ data: { serviceId } }) });
  const [adding, setAdding] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  if (query.isLoading) return <p>Loading size rules…</p>;
  if (query.error)
    return (
      <p role="alert" className="text-destructive">
        {query.error.message}
      </p>
    );
  const rules = query.data?.rules ?? [];
  return (
    <div className="min-w-0 space-y-3" data-testid="size-matrix">
      <p className="text-sm text-muted-foreground">
        Leave both fields empty to use the service's own price and length. A coat rule takes
        priority over the general size rule. Prices are per pet.
      </p>
      {PET_SIZES.map((size) => (
        <SizeRuleRow
          key={size}
          serviceId={serviceId}
          fixedSize={size}
          rule={rules.find((r) => r.size === size && r.coat_type === null)}
          onSaved={refresh}
        />
      ))}
      {rules
        .filter((r) => r.coat_type !== null)
        .map((r) => (
          <SizeRuleRow key={r.id} serviceId={serviceId} rule={r} onSaved={refresh} />
        ))}
      {adding && (
        <SizeRuleRow
          serviceId={serviceId}
          onSaved={() => {
            setAdding(false);
            refresh();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {!adding && (
        <Button className="min-h-11" variant="outline" onClick={() => setAdding(true)}>
          Add coat rule
        </Button>
      )}
    </div>
  );
}

function SizeRuleRow({
  serviceId,
  fixedSize,
  rule,
  onSaved,
  onCancel,
}: {
  serviceId: string;
  fixedSize?: PetSize;
  rule?: ServiceSizeRule;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const id = useId();
  const [size, setSize] = useState<PetSize>(rule?.size ?? fixedSize ?? "large");
  const [coat, setCoat] = useState<CoatType>(rule?.coat_type ?? "long");
  const [minutes, setMinutes] = useState(rule ? String(rule.duration_min) : "");
  const [price, setPrice] = useState(centsToDollarInput(rule?.price_cents));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMinutes(rule ? String(rule.duration_min) : "");
    setPrice(centsToDollarInput(rule?.price_cents));
    setSize(rule?.size ?? fixedSize ?? "large");
    setCoat(rule?.coat_type ?? "long");
  }, [rule?.duration_min, rule?.price_cents, rule?.size, rule?.coat_type, fixedSize]);
  const upsert = useServerFn(upsertServiceSizeRule);
  const remove = useServerFn(deleteServiceSizeRule);
  const save = useMutation({
    mutationFn: async (clear: boolean) => {
      if (clear || (!minutes.trim() && !price.trim() && fixedSize)) {
        if (!rule) return false;
        await remove({ data: { serviceId, id: rule.id } });
        return true;
      }
      const cents = parseDollarsToCents(price);
      const length = Number(minutes);
      if (cents === null || !Number.isInteger(cents) || cents < 0 || cents > 10_000_000)
        throw new Error("Enter a price from $0.00 to $100,000.00.");
      if (!Number.isInteger(length) || length < 1 || length > 720)
        throw new Error("Enter a length from 1 to 720 whole minutes.");
      await upsert({
        data: {
          id: rule?.id,
          serviceId,
          size,
          coatType: fixedSize ? null : coat,
          durationMin: length,
          priceCents: cents,
        },
      });
      return true;
    },
    onSuccess: (changed) => {
      setError(null);
      if (!changed) return;
      toast.success("Size rule saved");
      onSaved();
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <form
      className="grid min-w-0 gap-3 rounded-lg border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(false);
      }}
    >
      {fixedSize ? (
        <p className="self-center font-medium">{PET_SIZE_LABEL[fixedSize]}</p>
      ) : (
        <div className="min-w-0 space-y-2">
          <Label htmlFor={`${id}-size`}>Size</Label>
          <select
            id={`${id}-size`}
            className="min-h-11 w-full rounded-md border bg-background px-2"
            value={size}
            onChange={(e) => setSize(e.target.value as PetSize)}
          >
            {PET_SIZES.map((s) => (
              <option key={s} value={s}>
                {PET_SIZE_LABEL[s]}
              </option>
            ))}
          </select>
          <Label htmlFor={`${id}-coat`}>Coat type</Label>
          <select
            id={`${id}-coat`}
            className="min-h-11 w-full rounded-md border bg-background px-2"
            value={coat}
            onChange={(e) => setCoat(e.target.value as CoatType)}
          >
            {COAT_TYPES.map((c) => (
              <option key={c} value={c}>
                {COAT_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="min-w-0 space-y-1">
        <Label htmlFor={`${id}-minutes`}>
          Minutes{fixedSize ? `, ${PET_SIZE_LABEL[fixedSize]}` : ""}
        </Label>
        <Input
          id={`${id}-minutes`}
          className="min-h-11"
          type="number"
          inputMode="numeric"
          min={1}
          max={720}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          placeholder="Service default"
        />
      </div>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={`${id}-price`}>
          Price ($){fixedSize ? `, ${PET_SIZE_LABEL[fixedSize]}` : ""}
        </Label>
        <Input
          id={`${id}-price`}
          className="min-h-11"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="Service default"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" type="submit" disabled={save.isPending}>
          Save
        </Button>
        {(rule || onCancel) && (
          <Button
            className="min-h-11"
            type="button"
            variant="outline"
            disabled={save.isPending}
            onClick={() => (rule ? save.mutate(true) : onCancel?.())}
          >
            {rule ? "Clear" : "Cancel"}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive md:col-span-4">
          {error}
        </p>
      )}
    </form>
  );
}
