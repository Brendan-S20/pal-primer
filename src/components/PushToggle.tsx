import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Bell, BellOff } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n";
import { useMyRole } from "@/hooks/useMyRole";
import { useDismissed } from "@/lib/dismissible";
import {
  getPushPublicKey,
  subscribeStaffPush,
  unsubscribeStaffPush,
  subscribeClientPush,
  unsubscribeClientPush,
} from "@/lib/push.functions";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const b64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// ── A PROMISE THAT NEVER SETTLES IS NOT AN ERROR YOU CAN CATCH ───────────
//
// `navigator.serviceWorker.ready` resolves when a worker takes control. With
// no worker registered it does not reject: it simply never settles. So every
// `await` on it below hung forever, and because the `try` never completed, the
// `finally` that clears the busy flag never ran either.
//
// What that looked like: a user taps the bell, the browser asks for permission,
// THEY GRANT IT, and the button then sits spinning until the page is reloaded.
// No error, no toast, nothing in the console. The `catch` could not fire,
// because nothing ever went wrong in a way JavaScript recognises.
//
// It was live on /my-day and on BOTH client-portal pages, so customers met it
// too, on a screen where the only thing they can do about it is give up.
//
// /sw.js answered 404 in production from 2026-08-19 until 2026-09-10 (see
// PWA_OUT_DIR in vite.config.ts), which is what made the wait unbounded. That
// is fixed and this is no longer the everyday path, but the shape of the bug
// is worth removing regardless: a worker can be absent for reasons that have
// nothing to do with that fault -- an unregistered scope, a browser that
// evicted it, a user who cleared site data, a future deploy that breaks it
// again -- and none of those should end in a spinner with no way out.
//
// Five seconds is generous for a worker that is already installed and instant
// for one that is not coming.
const SW_READY_TIMEOUT_MS = 5000;

async function serviceWorkerReady(
  unavailableMessage = "Notifications are not available right now. Reload the page and try again.",
): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              // Reaches the user through the catch blocks below, so it says
              // what they can do rather than what failed internally.
              new Error(unavailableMessage),
            ),
          SW_READY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    // The race is settled either way; leaving the timer armed would fire a
    // rejection into a promise nobody is holding.
    if (timer) clearTimeout(timer);
  }
}

function arrayBufferToBase64(buf: ArrayBuffer | null) {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

interface Props {
  /** When provided, subscribes the client via portal token (unauthenticated). */
  portalToken?: string;
  /** Extra classes for the trigger button (e.g. to invert on dark backgrounds). */
  className?: string;
  /**
   * Icon only, with the words moved to the accessible name.
   *
   * For headers that have run out of horizontal room. "Enable notifications"
   * is 149px, which is most of a 320px row once anything else is on it -- in
   * My Day's title bar it squeezed the page heading to 0px wide. The glyph
   * already carries the state (Bell vs BellOff) and the 44px box is the same
   * pattern ui/dialog.tsx and ui/sheet.tsx use, so nothing is lost but the
   * width. The portal, which has the room, does not pass this.
   */
  compact?: boolean;
}

export function PushToggle({ portalToken, className, compact }: Props) {
  // Staff hear the language this device is set to. The portal passes a token
  // and is a customer's screen, which speaks the business's language: English,
  // whatever the customer's browser prefers.
  const { t: interfaceT } = useTranslation();
  const t = portalToken ? i18n.getFixedT("en") : interfaceT;
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [perm, setPerm] = useState<NotificationPermission>("default");

  const getKey = useServerFn(getPushPublicKey);
  const subStaff = useServerFn(subscribeStaffPush);
  const unsubStaff = useServerFn(unsubscribeStaffPush);
  const subClient = useServerFn(subscribeClientPush);
  const unsubClient = useServerFn(unsubscribeClientPush);

  useEffect(() => {
    const ok =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    setSupported(ok);
    if (!ok) return;
    setPerm(Notification.permission);
    // Deliberately still silent on failure: this only decides whether the bell
    // starts out filled, and a toast on page load for a worker that is merely
    // slow would be noise. The timeout is what matters, so the promise chain
    // ends instead of hanging.
    serviceWorkerReady()
      .then((reg) => reg.pushManager.getSubscription())
      .then((s) => setSubscribed(!!s))
      .catch(() => {});
  }, []);

  async function enable() {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      setPerm(permission);
      if (permission !== "granted") {
        toast.error(t("push.blocked"));
        return;
      }
      const { publicKey } = await getKey();
      if (!publicKey) {
        toast.error(t("push.notConfigured"));
        return;
      }
      const reg = await serviceWorkerReady(t("push.unavailable"));
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
      const raw = sub.toJSON() as any;
      const payload = {
        endpoint: sub.endpoint,
        p256dh: raw.keys?.p256dh ?? arrayBufferToBase64(sub.getKey("p256dh")),
        auth: raw.keys?.auth ?? arrayBufferToBase64(sub.getKey("auth")),
        userAgent: navigator.userAgent,
      };
      if (portalToken) {
        await subClient({ data: { ...payload, token: portalToken } });
      } else {
        await subStaff({ data: payload });
      }
      setSubscribed(true);
      toast.success(t("push.on"));
    } catch (e: any) {
      toast.error(e?.message ?? t("push.enableFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const reg = await serviceWorkerReady(t("push.unavailable"));
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        if (portalToken) {
          await unsubClient({ data: { token: portalToken, endpoint } });
        } else {
          await unsubStaff({ data: { endpoint } });
        }
      }
      setSubscribed(false);
      toast.success(t("push.off"));
    } catch (e: any) {
      toast.error(e?.message ?? t("push.disableFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!supported) return null;
  if (perm === "denied" && !portalToken) return <StaffBlocked compact={compact} />;
  if (perm === "denied") {
    // Also compact-able. This branch is easy to forget -- it is a `<span>`
    // rather than the Button the other two return, so it inherits none of
    // their sizing -- and it is 111px of unshrinkable text. That is what was
    // actually flattening My Day's heading at 320px, not the "Enable
    // notifications" button I first assumed: a browser that has denied
    // permission renders THIS, and a headless one always has.
    return (
      <span
        className={
          compact
            ? "inline-flex h-11 w-11 items-center justify-center text-muted-foreground"
            : "text-xs text-muted-foreground inline-flex items-center gap-1"
        }
        title={compact ? t("push.blocked") : undefined}
      >
        <BellOff className={compact ? "h-4 w-4" : "h-3 w-3"} />
        {compact ? <span className="sr-only">{t("push.blocked")}</span> : ` ${t("push.blocked")}`}
      </span>
    );
  }

  const label = subscribed ? t("push.on") : t("push.enable");
  return subscribed ? (
    <Button
      size="sm"
      variant="ghost"
      onClick={disable}
      disabled={busy}
      aria-label={compact ? label : undefined}
      title={compact ? label : undefined}
      className={(compact ? "min-h-11 w-11 px-0 " : "min-h-[36px] ") + (className ?? "")}
    >
      <Bell className={compact ? "h-4 w-4" : "h-4 w-4 me-1"} />
      {compact ? <span className="sr-only">{label}</span> : t("push.onShort")}
    </Button>
  ) : (
    <Button
      size="sm"
      variant="outline"
      onClick={enable}
      disabled={busy}
      aria-label={compact ? label : undefined}
      title={compact ? label : undefined}
      className={(compact ? "min-h-11 w-11 px-0 " : "min-h-[36px] ") + (className ?? "")}
    >
      <BellOff className={compact ? "h-4 w-4" : "h-4 w-4 me-1"} />
      {compact ? <span className="sr-only">{label}</span> : t("push.enable")}
    </Button>
  );
}

/**
 * "Notifications blocked", for staff, as something that can be put away.
 *
 * It sat in My Day's title bar every day for anybody whose browser had said
 * no, and nothing on the page can change that answer: only the browser's or
 * the phone's own settings can. Owner, 2026-10-03, on notices that cannot be
 * cleared away: "it would be nice to dismiss or hide them if they are not
 * necessary." So a tap hides it and says, once, where the switch actually is.
 *
 * Re-shows after 30 days, as a reminder that alerts are still off. If the
 * browser is switched back to allow, the normal bell replaces it whatever was
 * dismissed. The customer portal keeps the plain label; it is a customer's
 * screen and not ours to tidy. Rule in src/lib/dismissible.ts.
 */
function StaffBlocked({ compact }: { compact?: boolean }) {
  const { t } = useTranslation();
  const { orgId } = useMyRole();
  const { dismissed, dismiss } = useDismissed("push-blocked", "denied", {
    orgId,
    snoozeDays: 30,
  });
  if (dismissed) return null;
  const hide = () => {
    dismiss();
    toast(t("push.blockedHidden"));
  };
  return (
    <button
      type="button"
      onClick={hide}
      aria-label={t("push.blockedHide")}
      title={t("push.blockedHide")}
      className={
        compact
          ? "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
          : "inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent"
      }
    >
      <BellOff className={compact ? "h-4 w-4 shrink-0" : "h-3 w-3 shrink-0"} aria-hidden="true" />
      {compact ? null : t("push.blocked")}
    </button>
  );
}
