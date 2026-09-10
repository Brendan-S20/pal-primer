import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Bell, BellOff } from "lucide-react";
import { toast } from "sonner";
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

async function serviceWorkerReady(): Promise<ServiceWorkerRegistration> {
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
              new Error(
                "Notifications are not available right now. Reload the page and try again.",
              ),
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
}

export function PushToggle({ portalToken, className }: Props) {
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
        toast.error("Notifications blocked");
        return;
      }
      const { publicKey } = await getKey();
      if (!publicKey) {
        toast.error("Push not configured on server");
        return;
      }
      const reg = await serviceWorkerReady();
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
      toast.success("Notifications on");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not enable notifications");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const reg = await serviceWorkerReady();
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
      toast.success("Notifications off");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not disable");
    } finally {
      setBusy(false);
    }
  }

  if (!supported) return null;
  if (perm === "denied") {
    return (
      <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
        <BellOff className="h-3 w-3" /> Notifications blocked
      </span>
    );
  }

  return subscribed ? (
    <Button
      size="sm"
      variant="ghost"
      onClick={disable}
      disabled={busy}
      className={"min-h-[36px] " + (className ?? "")}
    >
      <Bell className="h-4 w-4 mr-1" /> On
    </Button>
  ) : (
    <Button
      size="sm"
      variant="outline"
      onClick={enable}
      disabled={busy}
      className={"min-h-[36px] " + (className ?? "")}
    >
      <BellOff className="h-4 w-4 mr-1" /> Enable notifications
    </Button>
  );
}
