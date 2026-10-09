// "Route on the lock screen" on Settings → Preferences, beside
// "Notifications on this phone".
//
// THE switch for the route's Live Activity (lib/live-activity-pref.ts), and
// since 2026-10-08 the only one: My Day's status-row toggle is gone. On, and
// the route goes on the lock screen by itself whenever the app opens or comes
// back to the front during a working day (RouteLockScreenHost, run by the
// signed-in layout). Off, and it never does, and turning it off takes down a
// route already showing, and with it the action token its Start button holds.
//
// iPhone app only. Renders nothing on the web and on Android, and nothing on
// an iPhone too old to draw one (Live Activities need iOS 16.2).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { endRouteActivity, liveActivityAvailable, liveActivitySupport } from "@/lib/live-activity";
import { useRouteOnLockScreen } from "@/lib/live-activity-pref";
import { endLiveActivityToken } from "@/lib/live-activity.functions";
import { reportClientError } from "@/lib/monitoring/client";

export function RouteOnLockScreenCard() {
  const { t } = useTranslation();
  const [available] = useState(() => liveActivityAvailable());
  const [support, setSupport] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const pref = useRouteOnLockScreen();
  const endFn = useServerFn(endLiveActivityToken);

  useEffect(() => {
    if (!available) return;
    let live = true;
    void liveActivitySupport().then((s) => live && setSupport(s));
    return () => {
      live = false;
    };
  }, [available]);

  if (!available || !support?.supported) return null;

  const change = async (on: boolean) => {
    pref.set(on);
    if (on) return;
    const ids = await endRouteActivity(undefined, "immediate");
    for (const id of ids) {
      try {
        await endFn({ data: { activityId: id, reason: "hidden" } });
      } catch (e) {
        reportClientError(e, { area: "live_activity", step: "end_token" });
      }
    }
  };

  return (
    <Card>
      <CardHeader>
        {/* One row, title and switch, so the card does not say its own name
            twice. The switch carries its own 44px hit area (ui/switch.tsx). */}
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <CardTitle>
              <label htmlFor="route-on-lock-screen" className="cursor-pointer">
                {t("liveActivity.cardTitle")}
              </label>
            </CardTitle>
            <CardDescription>{t("liveActivity.prefDescription")}</CardDescription>
          </div>
          <Switch
            id="route-on-lock-screen"
            checked={pref.on}
            disabled={!pref.ready}
            onCheckedChange={(v) => void change(v)}
            className="mt-0.5 shrink-0"
          />
        </div>
      </CardHeader>
      {!support.enabled && (
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("liveActivity.cardDisabled")}</p>
        </CardContent>
      )}
    </Card>
  );
}
