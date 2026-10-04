import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useServerFn } from "@tanstack/react-start";
import { Bell, BellRing, Settings as SettingsIcon } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  getPushPermission,
  isNative,
  openAppNotificationSettings,
  platform,
  turnOnPushNotifications,
  type PushPermission,
} from "@/lib/native";
import { sendMyselfTestPush } from "@/lib/push.functions";

// ── THE PROMPT YOU NEVER SAW, AND NO WAY TO ASK FOR IT ────────────────────
//
// On 2026-10-04 the owner signed in to the iOS app and the notifications
// prompt never appeared. Nothing in the app could bring it up: the shell asks
// once, on launch, and PushToggle is web push, which does nothing inside the
// native WebView. And iOS asks exactly once per install, so after a "Don't
// Allow" (or a prompt answered on an earlier build) the only way back is iOS
// Settings, which the app never mentioned.
//
// So this card says which of the four states the phone is in and offers the
// one thing that helps in each: the prompt, a test, the way to Settings, or
// the honest "not in this build". Native only; on the web PushToggle is the
// control and this renders nothing.

/** Lines that explain, under the title. One component so every state reads at
 *  the same size and wraps the same way at 320px. */
function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

// Buttons whose label is a translated sentence: allowed to wrap rather than
// push the card wider than a 320px phone (Spanish runs a third longer).
const WRAPPING_BUTTON = "h-auto min-h-9 whitespace-normal py-2 text-start";

export function NativePushCard() {
  const { t } = useTranslation();
  const [native] = useState(() => isNative());
  const [state, setState] = useState<PushPermission | null>(null);
  const [busy, setBusy] = useState(false);
  const sendTest = useServerFn(sendMyselfTestPush);

  const refresh = useCallback(async () => {
    try {
      setState(await getPushPermission());
    } catch {
      setState(null);
    }
  }, []);

  useEffect(() => {
    if (!native) return;
    void refresh();
    // Coming back from iOS Settings is a resume, not a navigation, so the
    // card would otherwise go on saying "off" over a switch just turned on.
    let remove: (() => void) | undefined;
    let gone = false;
    void import("@capacitor/app")
      .then(({ App }) => App.addListener("resume", () => void refresh()))
      .then((h) => {
        if (gone) void h.remove();
        else remove = () => void h.remove();
      })
      .catch(() => {});
    return () => {
      gone = true;
      remove?.();
    };
  }, [native, refresh]);

  if (!native) return null;

  const turnOn = async () => {
    setBusy(true);
    try {
      const { permission } = await turnOnPushNotifications();
      setState(permission);
      if (permission === "granted") toast.success(t("nativePush.turnedOn"));
    } catch {
      toast.error(t("nativePush.turnOnFailed"));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const r = await sendTest({
        data: { title: t("nativePush.testTitle"), body: t("nativePush.testBody") },
      });
      if (!r.ok) toast.message(t("nativePush.testTooSoon", { count: r.retryAfterSeconds }));
      else if (r.sent > 0) toast.success(t("nativePush.testSent", { count: r.sent }));
      else toast.error(t("nativePush.testNone"));
    } catch {
      toast.error(t("nativePush.testFailed"));
    } finally {
      setBusy(false);
    }
  };

  const ios = platform() === "ios";

  return (
    <Card data-native-push-state={state ?? "checking"}>
      <CardHeader>
        <CardTitle>{t("nativePush.title")}</CardTitle>
        <CardDescription>{t("nativePush.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {state === null && <Note>{t("common.loading")}</Note>}

        {state === "prompt" && (
          <>
            <Note>{t("nativePush.promptBody")}</Note>
            <Button onClick={turnOn} disabled={busy} className={WRAPPING_BUTTON}>
              <Bell className="h-4 w-4 shrink-0" aria-hidden />
              {t("nativePush.turnOn")}
            </Button>
          </>
        )}

        {state === "granted" && (
          <>
            <Note>{t("nativePush.onBody")}</Note>
            <Button
              variant="outline"
              onClick={test}
              disabled={busy}
              className={WRAPPING_BUTTON}
            >
              <BellRing className="h-4 w-4 shrink-0" aria-hidden />
              {t("nativePush.sendTest")}
            </Button>
          </>
        )}

        {state === "denied" && (
          <>
            <Note>{ios ? t("nativePush.deniedBodyIos") : t("nativePush.deniedBodyAndroid")}</Note>
            {/* iOS only: see openAppNotificationSettings for why Android gets
                the path in words and no button. */}
            {ios && (
              <Button
                variant="outline"
                onClick={() => openAppNotificationSettings()}
                className={WRAPPING_BUTTON}
              >
                <SettingsIcon className="h-4 w-4 shrink-0" aria-hidden />
                {t("nativePush.openSettings")}
              </Button>
            )}
          </>
        )}

        {state === "unavailable" && <Note>{t("nativePush.unavailable")}</Note>}
      </CardContent>
    </Card>
  );
}
