import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import {
  getNotificationPrefs,
  setNotificationPrefs,
} from "@/lib/notifications-center.functions";

/**
 * "Choose what shows up here" — which notification types are muted.
 *
 * ── WHY IT LIVES IN ITS OWN FILE ──────────────────────────────────────────
 *
 * It used to be a private component inside NotificationBell, reachable only
 * through a gear icon in that bell's dropdown. The bell is now a link to
 * /notifications rather than a dropdown, and moving it without moving this
 * would have quietly deleted the only way to reach notification settings —
 * the kind of loss that does not fail a test, because nothing asserts that a
 * screen is reachable. Extracted so exactly one copy exists and the page owns
 * the entry point.
 *
 * ── AND WHY THE CONTROL CHANGED ───────────────────────────────────────────
 *
 * It was a bare `<input type="checkbox">`: a ~16px target, well under the 44px
 * this codebase requires, on a row whose label was not clickable either. On a
 * phone that is a setting you aim at and miss. `Switch` is the primitive the
 * rest of the app uses, and the whole row is now the hit area.
 */
export function NotificationPrefs() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const getFn = useServerFn(getNotificationPrefs);
  const setFn = useServerFn(setNotificationPrefs);
  const q = useQuery({ queryKey: ["notification-prefs"], queryFn: () => getFn() });
  const data = q.data as any;
  const muted: string[] = data?.mutedTypes ?? [];
  const types: Array<{ type: string; label: string }> = data?.types ?? [];

  const save = useMutation({
    mutationFn: (next: string[]) => setFn({ data: { mutedTypes: next } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notification-prefs"] }),
  });

  const toggle = (type: string, on: boolean) => {
    const next = on ? muted.filter((m) => m !== type) : Array.from(new Set([...muted, type]));
    save.mutate(next);
  };

  if (q.isLoading) {
    return <p className="py-4 text-sm text-muted-foreground">{t("common.loading")}</p>;
  }

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">{t("alerts.prefsIntro")}</p>
      <ul className="divide-y">
        {types.map((nt) => {
          const on = !muted.includes(nt.type);
          // Translated by code; the server's English label is the fallback
          // for a type added there before it is added to lib/i18n.
          const label = t(`notificationType.${nt.type}`, { defaultValue: nt.label });
          return (
            <li key={nt.type}>
              {/* The label wraps the switch, so the whole row toggles it —
                  `min-h-11` makes that row a legal target at every width. */}
              <label className="flex min-h-11 min-w-0 cursor-pointer items-center justify-between gap-3 py-1 text-sm">
                <span className="min-w-0 flex-1">{label}</span>
                <Switch
                  checked={on}
                  disabled={save.isPending}
                  onCheckedChange={(v) => toggle(nt.type, v)}
                  aria-label={label}
                />
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
