// Beside a groom's pets on its card (#412): whether the van can plug in or
// fill up at the address, and the add-ons booked on this groom, each one a box
// the groomer ticks off. An add-on left unticked is not billed when the groom
// is completed (set_groom_addon_done, 20261109130000). An add-on done on the
// day that was not booked is the field add-on further down the card.

import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Droplet, Plug, Sparkles } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { getGroomVisitExtras, setGroomAddonDone } from "@/lib/groom-visit-extras.functions";
import type { GroomVisitAddon, GroomVisitExtras as Extras } from "@/lib/groom-visit-extras";

export function GroomVisitExtras({ visitId, canWrite }: { visitId: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const getFn = useServerFn(getGroomVisitExtras);
  const q = useQuery({
    queryKey: ["groom-visit-extras", visitId],
    queryFn: () => getFn({ data: { visitId } }),
    staleTime: 30_000,
  });
  const extras = q.data;
  if (!extras) return null;

  const { power, water } = extras.van;
  return (
    <div className="space-y-2">
      <section className="min-w-0 rounded-lg border p-2.5 text-sm">
        <p className="text-xs font-medium text-muted-foreground">{t("groom.vanTitle")}</p>
        {power || water ? (
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {power && (
              <li className="flex min-w-0 items-center gap-1.5">
                <Plug className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                <span className="min-w-0">{t("groom.vanPower")}</span>
              </li>
            )}
            {water && (
              <li className="flex min-w-0 items-center gap-1.5">
                <Droplet className="h-4 w-4 shrink-0 text-sky-600" aria-hidden />
                <span className="min-w-0">{t("groom.vanWater")}</span>
              </li>
            )}
          </ul>
        ) : (
          <p className="mt-1 text-muted-foreground">{t("groom.vanNone")}</p>
        )}
      </section>
      {extras.addons.length > 0 && (
        <AddonList extras={extras} canMark={canWrite && extras.canMark} />
      )}
    </div>
  );
}

function AddonList({ extras, canMark }: { extras: Extras; canMark: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const setFn = useServerFn(setGroomAddonDone);
  const key = ["groom-visit-extras", extras.visitId];
  const label = (a: GroomVisitAddon) => {
    const name = a.name || t("groom.addonFallback");
    return a.quantity > 1 ? t("groom.addonQuantity", { name, count: a.quantity }) : name;
  };
  const mark = useMutation({
    mutationFn: (v: { addon: GroomVisitAddon; done: boolean }) =>
      setFn({
        data: { visitId: extras.visitId, addonServiceId: v.addon.addonServiceId, done: v.done },
      }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<Extras | null>(key);
      if (before) {
        qc.setQueryData<Extras>(key, {
          ...before,
          addons: before.addons.map((a) =>
            a.addonServiceId === v.addon.addonServiceId ? { ...a, done: v.done } : a,
          ),
        });
      }
      return { before };
    },
    onSuccess: (_r, v) => {
      const name = label(v.addon);
      toast.success(
        v.done ? t("groom.addonMarkedDone", { name }) : t("groom.addonMarkedNotDone", { name }),
      );
    },
    onError: (e: Error, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(key, ctx.before);
      toast.error(e.message);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });

  return (
    <section className="min-w-0 rounded-lg border p-2.5 text-sm">
      <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">{t("groom.addonsTitle")}</span>
      </p>
      <ul className="mt-1 space-y-1">
        {extras.addons.map((a) => {
          const id = `addon-${extras.visitId}-${a.addonServiceId}`;
          return (
            <li key={a.addonServiceId}>
              <label
                htmlFor={id}
                className={`flex min-h-11 min-w-0 items-center gap-3 rounded-md px-1 ${
                  canMark ? "cursor-pointer" : ""
                }`}
              >
                <Checkbox
                  id={id}
                  checked={a.done}
                  disabled={!canMark || mark.isPending}
                  onCheckedChange={(v) => mark.mutate({ addon: a, done: v === true })}
                />
                <span
                  className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${
                    a.done ? "" : "text-muted-foreground line-through"
                  }`}
                >
                  <bdi>{label(a)}</bdi>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {a.done ? t("groom.addonDone") : t("groom.addonNotDone")}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {canMark && <p className="mt-1 text-xs text-muted-foreground">{t("groom.addonsHint")}</p>}
    </section>
  );
}
