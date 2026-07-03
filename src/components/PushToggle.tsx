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
    navigator.serviceWorker.ready
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
      const reg = await navigator.serviceWorker.ready;
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
      const reg = await navigator.serviceWorker.ready;
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
    <Button size="sm" variant="ghost" onClick={disable} disabled={busy} className="min-h-[36px]">
      <Bell className="h-4 w-4 mr-1" /> On
    </Button>
  ) : (
    <Button size="sm" variant="outline" onClick={enable} disabled={busy} className="min-h-[36px]">
      <BellOff className="h-4 w-4 mr-1" /> Enable notifications
    </Button>
  );
}
