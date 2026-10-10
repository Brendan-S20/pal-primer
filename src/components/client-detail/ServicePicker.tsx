// The plan form's Service picker (service catalog, phase 2). Lists the
// business's active services from Settings → Services, plus the plan's
// current one if it has since been deactivated, and starts a new plan on
// pet waste removal. The rules are in src/lib/visit-service.ts.
//
// Shares Settings → Services' query key, so a service added or renamed there
// is what this lists without a reload.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Label } from "@/components/ui/label";
import { listServices } from "@/lib/services.functions";
import { defaultServiceId, servicePickerOptions } from "@/lib/visit-service";
import type { Service } from "@/lib/services";

export const SERVICES_QUERY_KEY = ["services", "all"] as const;

/** The services this business sells, every one of them (the picker narrows). */
export function useOrgServices(enabled = true) {
  const list = useServerFn(listServices);
  const { data, isLoading } = useQuery({
    queryKey: SERVICES_QUERY_KEY,
    queryFn: () => list({ data: { includeInactive: true } }),
    enabled,
  });
  return { services: (data?.services ?? []) as Service[], isLoading };
}

/** What a picker with nothing chosen yet shows, and what Save sends. */
export function effectiveServiceId(chosen: string, services: readonly Service[]): string | null {
  return chosen || defaultServiceId(services);
}

export function ServicePicker({
  id = "sd-service",
  value,
  currentId,
  services,
  isLoading,
  onChange,
}: {
  id?: string;
  /** What the person chose; "" until they choose (the default shows). */
  value: string;
  /** The plan's saved service, kept in the list even when inactive. */
  currentId: string | null;
  services: readonly Service[];
  isLoading: boolean;
  onChange: (serviceId: string) => void;
}) {
  const options = servicePickerOptions(services, currentId);
  const selected = effectiveServiceId(value, services) ?? "";
  return (
    <div className="min-w-0">
      <Label htmlFor={id}>Service</Label>
      <select
        id={id}
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        disabled={isLoading || options.length === 0}
        className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm touch:h-11"
      >
        {isLoading && <option value="">Loading…</option>}
        {!isLoading && options.length === 0 && <option value="">Pet waste removal</option>}
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {s.active ? s.name : `${s.name} (no longer offered)`}
          </option>
        ))}
      </select>
    </div>
  );
}
