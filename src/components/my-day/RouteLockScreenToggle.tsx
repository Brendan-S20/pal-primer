// The route on the lock screen, as one icon in My Day's status row.
//
// It was a full-width card ("Route on the lock screen / Showing on your lock
// screen / Hide"), and with the time clock's card above it the first stop
// started halfway down the phone. The route starts by itself on Clock in or
// the first Start (useRouteLiveActivity), so all a tech needs from this
// screen is a way to hide it or bring it back: a phone glyph, filled while
// the route is on the lock screen, and a toast that says which way it went.
//
// iPhone app only, like the activity: renders nothing on the web and on
// Android, nothing on a day that is not the tech's own today, and nothing
// once the route is finished and gone.

import { useTranslation } from "react-i18next";
import { Smartphone } from "lucide-react";
import type { RouteLiveActivity } from "@/components/my-day/useRouteLiveActivity";

export function RouteLockScreenToggle({ activity }: { activity: RouteLiveActivity }) {
  const { t } = useTranslation();
  if (!activity.relevant) return null;
  const { showing, allowed, busy, toggle } = activity;
  return (
    <button
      type="button"
      // The name is the feature; aria-pressed says whether it is on. A screen
      // reader hears "Route on the lock screen, toggle button, pressed".
      aria-label={t("liveActivity.cardTitle")}
      aria-pressed={showing}
      title={
        !allowed
          ? t("liveActivity.cardDisabled")
          : showing
            ? t("liveActivity.cardOn")
            : t("liveActivity.cardOff")
      }
      disabled={busy}
      onClick={toggle}
      data-route-lock-screen={showing ? "showing" : "hidden"}
      className={`inline-flex size-11 shrink-0 items-center justify-center rounded-lg border transition-colors active:scale-95 disabled:opacity-60 ${
        showing
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-background text-muted-foreground hover:bg-muted"
      }`}
    >
      <Smartphone className="h-4 w-4 shrink-0" aria-hidden="true" />
    </button>
  );
}
