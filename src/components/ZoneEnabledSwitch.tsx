// The on/off switch for a zone (#449), on each zone card and in the zone
// drawer. Saves the moment it is pressed. Owner only: anyone else sees the
// status and a disabled switch. Rules and copy live in src/lib/zone-enabled.ts.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { useMyRole } from "@/hooks/useMyRole";
import { setZoneEnabled } from "@/lib/zones.functions";
import { canToggleZone, toggledToast, turnOffConfirm, zoneStatusLabel } from "@/lib/zone-enabled";
import { cn } from "@/lib/utils";

export function ZoneEnabledSwitch({
  zone,
  activeClientsKnown = true,
  onChanged,
  className,
}: {
  zone: { id: string; name: string; enabled?: boolean | null; active_clients?: number | null };
  /** False when the counts could not be read: then every turn-off asks. */
  activeClientsKnown?: boolean;
  onChanged?: (enabled: boolean) => void;
  className?: string;
}) {
  const setFn = useServerFn(setZoneEnabled);
  const qc = useQueryClient();
  const { role } = useMyRole();
  const { confirm, dialog } = useConfirmDialog();
  const enabled = zone.enabled !== false;
  const canToggle = canToggleZone(role);
  const switchId = `zone-enabled-${zone.id}`;

  const mut = useMutation({
    mutationFn: (next: boolean) => setFn({ data: { id: zone.id, enabled: next } }),
    onSuccess: (r: { enabled: boolean; propertiesUpdated: number }) => {
      toast.success(toggledToast(zone.name, r.enabled, r.propertiesUpdated));
      qc.invalidateQueries({ queryKey: ["zones"] });
      qc.invalidateQueries({ queryKey: ["zone-coverage"] });
      onChanged?.(r.enabled);
    },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  const onCheckedChange = async (next: boolean) => {
    if (!next) {
      const count = zone.active_clients ?? 0;
      const ask = activeClientsKnown
        ? turnOffConfirm(zone.name, count)
        : {
            title: `Turn off ${zone.name}?`,
            description:
              "Clients already in this zone keep their schedule and price. New addresses, the signup page and the lead form will skip it until you turn it back on.",
            confirmLabel: "Turn off zone",
          };
      if (ask && !(await confirm({ ...ask, destructive: true }))) return;
    }
    mut.mutate(next);
  };

  return (
    <div className={cn("flex min-h-11 flex-wrap items-center gap-x-2", className)}>
      <Switch
        id={switchId}
        checked={enabled}
        disabled={!canToggle || mut.isPending}
        onCheckedChange={onCheckedChange}
        aria-label={`${zone.name} is ${enabled ? "on" : "off"}`}
        title={canToggle ? undefined : "Only an owner can turn a zone on or off."}
      />
      <label
        htmlFor={switchId}
        className={cn("text-sm font-medium", enabled ? "text-foreground" : "text-muted-foreground")}
      >
        {zoneStatusLabel(enabled)}
      </label>
      {/* Visible, not only a tooltip: a title never shows on touch. Waits for
          the role so an owner never sees it flash while it loads. */}
      {role && !canToggle && (
        <span className="text-xs text-muted-foreground">
          Only an owner can turn a zone on or off.
        </span>
      )}
      {dialog}
    </div>
  );
}
