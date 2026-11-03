import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useMyRole } from "@/hooks/useMyRole";
import { useDismissed } from "@/lib/dismissible";
import { getPushPermission, isNative, turnOnPushNotifications } from "@/lib/native";

// ── THE WORD BEFORE THE SYSTEM PROMPT (R2-35) ─────────────────────────────
//
// The signed-in shell used to ask for notification permission on every
// launch, so on a fresh install iOS put "HoundStack Would Like to Send You
// Notifications" over the dashboard within three seconds of signing in, and
// on an iPad fifteen minutes later over an open date picker. Nothing in the
// app had said what the notifications were for, and iOS asks exactly once.
//
// The shell now only registers a phone that already said yes (`ask: false`).
// A phone that has not been asked gets this: one line in the page flow, under
// the other banners, saying what it is for. The system prompt comes up only
// from its button (or the Preferences card's). "Not now" puts it away for a
// fortnight. Native only, and only while the answer is still open.

const SNOOZE_DAYS = 14;

export function NativePushExplainer() {
  const { t } = useTranslation();
  const { orgId } = useMyRole();
  const { dismissed, dismiss } = useDismissed("native-push-explainer", "1", {
    orgId,
    snoozeDays: SNOOZE_DAYS,
  });
  const [unasked, setUnasked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isNative()) return;
    let gone = false;
    getPushPermission()
      .then((p) => {
        if (!gone) setUnasked(p === "prompt");
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);

  if (!unasked || dismissed) return null;

  const turnOn = async () => {
    setBusy(true);
    try {
      const { permission } = await turnOnPushNotifications();
      // Whatever the answer, it is an answer: iOS will not ask again.
      setUnasked(false);
      if (permission === "granted") toast.success(t("nativePush.turnedOn"));
    } catch {
      toast.error(t("nativePush.turnOnFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-native-push-explainer=""
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/40 px-4 py-2 text-sm"
    >
      <div className="flex min-w-0 flex-1 basis-64 items-start gap-2">
        <Bell className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium">{t("nativePush.explainerTitle")}</p>
          <p className="text-muted-foreground">{t("nativePush.explainerBody")}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="ghost" onClick={dismiss} disabled={busy}>
          {t("nativePush.notNow")}
        </Button>
        <Button size="sm" onClick={turnOn} disabled={busy}>
          {t("nativePush.turnOn")}
        </Button>
      </div>
    </div>
  );
}
