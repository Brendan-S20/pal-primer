// What the Settings card and the announcement share: whether this person and
// this business can use Tap to Pay, whether Apple's terms are accepted, and
// the "Enable Tap to Pay on iPhone" action (Apple's review guide 3.5, 3.6)
// that lets the owner accept them outside checkout.
import { useCallback, useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useQuery } from "@tanstack/react-query";
import { getTapToPayStatus, prepareTapToPay } from "@/lib/tap-to-pay.functions";
import {
  connectTapToPayReader,
  ensureTerminal,
  tapToPayTermsAccepted,
} from "@/lib/tap-to-pay-terminal";
import { describeTapToPayError, deviceCanTapToPay, iosUpdateAdvice } from "@/lib/tap-to-pay";

export function useTapToPayDevice() {
  const platform = Capacitor.getPlatform();
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return {
    platform,
    userAgent,
    canTap: deviceCanTapToPay(platform, userAgent),
    iosUpdate: iosUpdateAdvice(platform, userAgent),
  };
}

export function useTapToPayStatus() {
  return useQuery({
    queryKey: ["tap-to-pay-status"],
    queryFn: () => getTapToPayStatus(),
    staleTime: 5 * 60_000,
  });
}

export type EnableState =
  | { kind: "checking" }
  | { kind: "off" } // terms not accepted yet
  | { kind: "working" }
  | { kind: "on" }
  | { kind: "error"; message: string };

/**
 * Apple's terms status for this business, read from Apple each time the
 * surface opens (1.6), and the Enable action. `enabled` is false until the
 * device and the business can tap; then it checks.
 */
export function useTapToPayEnable(enabled: boolean, platform: string) {
  const [state, setState] = useState<EnableState>({ kind: "checking" });

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    (async () => {
      try {
        const prep = await prepareTapToPay({ data: {} });
        const plugin = await ensureTerminal(prep.isTest);
        const linked = await tapToPayTermsAccepted(plugin, platform);
        const { reader } = await plugin.StripeTerminal.getConnectedReader();
        if (!live) return;
        // Android has no terms to accept: a connected reader means ready.
        setState(linked === true || (linked === null && reader) ? { kind: "on" } : { kind: "off" });
      } catch (e) {
        if (live) setState({ kind: "error", message: describeTapToPayError(e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled, platform]);

  const enable = useCallback(async () => {
    setState({ kind: "working" });
    try {
      const prep = await prepareTapToPay({ data: {} });
      // allowTerms: only the owner reaches this button (canAcceptTerms).
      await connectTapToPayReader(prep, { platform, allowTerms: true });
      setState({ kind: "on" });
      return true;
    } catch (e) {
      const online = typeof navigator === "undefined" ? true : navigator.onLine;
      setState({ kind: "error", message: describeTapToPayError(e, { online }) });
      return false;
    }
  }, [platform]);

  return { state, enable };
}
