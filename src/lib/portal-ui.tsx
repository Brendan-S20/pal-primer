/* Shared UI, hooks, and helpers for the client portal.
 * All sibling routes under /portal/$token/* pull data from usePortal(token).
 * React Query caches by key so switching tabs is instant. */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_TIMEZONE, orgLocalTime, orgToday } from "@/lib/org-day";
import { cadenceLabel, frequencyLabel } from "@/lib/frequency-request";
import { stationDisplayName } from "@/lib/dna-linkage";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { toast } from "sonner";
import {
  Camera,
  CheckCircle2,
  Clock,
  CloudRain,
  MapPin,
  MessageCircleWarning,
  PalmtreeIcon,
  Share2,
  X,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { useNavigate } from "@tanstack/react-router";
import { customerSkipReason } from "@/lib/skip-rules.functions";
import { isInsideRecleanWindow, recleanDeadlineLabel } from "@/lib/reclean";
import { walkSkipReason } from "@/lib/walk-notify";
import {
  VISIT_CONCERN_OPTIONS,
  WALK_CONCERN_OPTIONS,
  isWalkLine,
  isYardVisit,
} from "@/lib/walk-concerns";
import { oneOffRequestState } from "@/lib/one-off-booking";
import {
  portalContext,
  portalRequestOtp,
  portalVerifyOtp,
  portalOrgBySlug,
  portalIdentify,
  portalVerifyGenericOtp,
  portalChooseAccount,
  portalRedeemCode,
  portalGetClient,
  portalListUpcomingVisits,
  portalListInvoices,
  portalListPrepaidSubs,
  portalRequestSkip,
  portalRescheduleVisit,
  portalChangeFrequency,
  portalListAddonCatalog,
  portalListClientAddons,
  portalSubscribeAddon,
  portalCancelAddon,
  portalSetAutopay,
  portalRemoveCard,
  portalPayInvoiceWithSavedCard,
  portalListRecentVisits,
  portalListDogs,
  portalReportConcern,
  portalRequestReclean,
  portalSignPhotoUrls,
  portalGetReferral,
  portalListStations,
  portalListMyRequests,
  portalRequestVacationHold,
  portalRedeemPromo,
} from "@/lib/portal.functions";
import { shiftDay } from "@/lib/booking-dates";

/* ────────────────────────── formatting helpers ───────────────────────── */

export function money(cents: number | null | undefined, currency = "usd") {
  const v = (cents ?? 0) / 100;
  return v.toLocaleString(undefined, { style: "currency", currency: currency.toUpperCase() });
}

export function toDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T00:00:00") : new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function fmtDay(s: string | null | undefined) {
  const d = toDate(s);
  if (!d) return "";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export function fmtDayShort(s: string | null | undefined) {
  const d = toDate(s);
  if (!d) return "";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// There is deliberately no fmtTime here anymore. It was the portal's own
// private copy of `toLocaleTimeString` with no timeZone — the fourth such copy
// this codebase has retired — and it rendered every ETA and completion time on
// the DEVICE's clock. "Arriving 8:00 AM" means the truck's 8:00 AM: a customer
// checking their yard's portal from a business trip two zones east was told
// 10:00 AM, and the staff surfaces had already moved to the org's clock on
// 2026-09-19, so the two apps disagreed about the same visit. Instants now go
// through `orgLocalTime(instant, tz)` from org-day.ts with the tz from
// `usePortalTimezone()` below — DATE columns (scheduled_on, due_on) stay with
// fmtDay/fmtDayShort, which need no zone.

/** Weekday + clock + named zone for the change cutoff, on the ORG's clock:
 *  "Friday at 7:00 PM CDT". "" for garbage, like every helper in org-day.ts.
 *
 *  This line used to render device-local, with a written rationale: the
 *  reader is the one being told when THEY have until, so their own clock is
 *  the honest one. That loses, and here is why. The deadline is ENFORCED on
 *  the org's clock — portal_change_deadline computes it in the org's timezone
 *  and the skip/reschedule RPCs refuse against that same instant — and a
 *  device-local print with no zone name gives the reader no way to tell whose
 *  clock they are looking at. Every other time on the page is now org-local
 *  (the ETA window above this line is the truck's morning, not the reader's),
 *  so a customer who travels reads "arriving 8:00 AM" org-local and "changes
 *  until 7:00 PM" device-local in the same card and cannot know the second one
 *  switched frames. Worst case the device clock runs AHEAD of the org's: the
 *  un-named device-local print then reads later than the real deadline, and
 *  the customer misses it trusting a sentence that was technically their own
 *  time. Org-local WITH THE ZONE NAMED is unambiguous in every frame: a reader
 *  in the org's zone sees their own wall clock plus a familiar "CDT", and a
 *  travelling reader sees exactly which clock governs. (`pastCutoff` above
 *  compares raw instants and never cared which zone anything printed in.) */
function fmtCutoff(s: string | null | undefined, tz: string): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  const zone = tz || DEFAULT_ORG_TIMEZONE;
  // Weekday and zone abbreviation come from their own formatters (device
  // locale, org zone — same split as org-day.ts); the clock itself is the one
  // canonical helper so this can never drift from the ETA line above it.
  const weekday = new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: "long" }).format(d);
  const zoneName =
    new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      hour: "numeric",
      timeZoneName: "short",
    })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${weekday} at ${orgLocalTime(s, zone)}${zoneName ? ` ${zoneName}` : ""}`;
}

export function relativeFromToday(s: string | null | undefined): string {
  const d = toDate(s);
  if (!d) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1 && days <= 14) return `in ${days} days`;
  if (days < -1 && days >= -14) return `${-days} days ago`;
  return "";
}

// Delegates to the canonical shared label map (I3).
export function friendlyFrequency(f: string | null | undefined) {
  if (!f) return "";
  return frequencyLabel(f);
}

export function friendlyCategory(c: string | null | undefined) {
  const map: Record<string, string> = {
    missed_spot: "Missed spot",
    gate_left_open: "Gate left open",
    damage: "Damage",
    wrong_yard: "Wrong yard",
    other: "Other",
    reclean_request: "Re-clean request",
    one_off_request: "Extra visit",
    groom_request: "Groom request",
    training_lesson_request: "Training lesson",
  };
  return map[c ?? ""] ?? c ?? "";
}

export function friendlyStatus(s: string) {
  const map: Record<string, string> = {
    open: "Received",
    received: "Received",
    // What qc_tickets actually stores for "the office has picked it up" --
    // its CHECK allows open / acknowledged / resolved. Without this line the
    // customer saw the raw word, or "Received" on a re-clean already booked.
    acknowledged: "In review",
    in_review: "In review",
    pending: "In review",
    resolved: "Resolved",
    closed: "Resolved",
  };
  return map[s] ?? s;
}

export function isHex(s: string | null | undefined): s is string {
  return !!s && /^#[0-9a-f]{3,8}$/i.test(s);
}

/* ─────────────────────── shared data hook ─────────────────────── */

export function usePortal(token: string, slug?: string) {
  const qc = useQueryClient();

  const getClientFn = useServerFn(portalGetClient);
  const listVisitsFn = useServerFn(portalListUpcomingVisits);
  const listInvoicesFn = useServerFn(portalListInvoices);
  const listSubsFn = useServerFn(portalListPrepaidSubs);
  const skipFn = useServerFn(portalRequestSkip);
  const rescheduleFn = useServerFn(portalRescheduleVisit);
  const changeFreqFn = useServerFn(portalChangeFrequency);
  const listAddonCatalogFn = useServerFn(portalListAddonCatalog);
  const listClientAddonsFn = useServerFn(portalListClientAddons);
  const subscribeAddonFn = useServerFn(portalSubscribeAddon);
  const cancelAddonFn = useServerFn(portalCancelAddon);
  const setAutopayFn = useServerFn(portalSetAutopay);
  const removeCardFn = useServerFn(portalRemoveCard);
  const payWithSavedFn = useServerFn(portalPayInvoiceWithSavedCard);
  const historyFn = useServerFn(portalListRecentVisits);
  const dogsFn = useServerFn(portalListDogs);
  const referralFn = useServerFn(portalGetReferral);
  const concernFn = useServerFn(portalReportConcern);
  const recleanFn = useServerFn(portalRequestReclean);
  const signPhotosFn = useServerFn(portalSignPhotoUrls);
  const stationsFn = useServerFn(portalListStations);
  const requestsFn = useServerFn(portalListMyRequests);
  const vacationFn = useServerFn(portalRequestVacationHold);
  const promoFn = useServerFn(portalRedeemPromo);

  const staleTime = 30_000;

  // Auth gate (finding #4): a device is unverified until it passes an OTP.
  // Every data query below is disabled until the session cookie is valid, so
  // no client data is fetched behind the verify screen.
  const contextFn = useServerFn(portalContext);
  const requestOtpFn = useServerFn(portalRequestOtp);
  const verifyOtpFn = useServerFn(portalVerifyOtp);
  const contextQ = useQuery({
    queryKey: ["portal", token, "context"],
    queryFn: async () => {
      const withHome = qc.getQueryData(["portal", token, "client"]) === undefined;
      const answer = await contextFn({ data: { token, ...(withHome ? { withHome: true } : {}) } });
      if (!answer.verified) return answer;
      const { home, ...context } = answer;
      if (home) {
        for (const [part, value] of Object.entries(home)) {
          qc.setQueryData(["portal", token, part], value);
        }
      }
      return context;
    },
    staleTime,
    retry: false,
  });
  const verified = !!(contextQ.data && "verified" in contextQ.data && contextQ.data.verified);
  const gated = { staleTime, enabled: verified };

  const clientQ = useQuery({
    queryKey: ["portal", token, "client"],
    queryFn: () => getClientFn({ data: { token } }),
    ...gated,
  });
  const visitsQ = useQuery({
    queryKey: ["portal", token, "visits"],
    queryFn: () => listVisitsFn({ data: { token } }),
    ...gated,
  });
  const invoicesQ = useQuery({
    queryKey: ["portal", token, "invoices"],
    queryFn: () => listInvoicesFn({ data: { token } }),
    ...gated,
  });
  const subsQ = useQuery({
    queryKey: ["portal", token, "subs"],
    queryFn: () => listSubsFn({ data: { token } }),
    ...gated,
  });
  const catalogQ = useQuery({
    queryKey: ["portal", token, "catalog"],
    queryFn: () => listAddonCatalogFn({ data: { token } }),
    ...gated,
  });
  const clientAddonsQ = useQuery({
    queryKey: ["portal", token, "clientAddons"],
    queryFn: () => listClientAddonsFn({ data: { token } }),
    ...gated,
  });
  const historyQ = useQuery({
    queryKey: ["portal", token, "history"],
    queryFn: () => historyFn({ data: { token } }),
    ...gated,
  });
  const dogsQ = useQuery({
    queryKey: ["portal", token, "dogs"],
    queryFn: () => dogsFn({ data: { token } }),
    ...gated,
  });
  const referralQ = useQuery({
    queryKey: ["portal", token, "referral"],
    queryFn: () => referralFn({ data: { token } }),
    ...gated,
  });
  const stationsQ = useQuery({
    queryKey: ["portal", token, "stations"],
    queryFn: () => stationsFn({ data: { token } }),
    ...gated,
  });
  const requestsQ = useQuery({
    queryKey: ["portal", token, "requests"],
    queryFn: () => requestsFn({ data: { token } }),
    ...gated,
  });

  const invalidatePortal = () => qc.invalidateQueries({ queryKey: ["portal", token] });

  const requestOtpMut = useMutation({
    mutationFn: (channel: "sms" | "email") => requestOtpFn({ data: { token, channel } }),
    // A failed SMS attempt's error toast used to linger through a later
    // successful email-code request, reading as "still broken" (P0.5) —
    // clear stale error toasts the moment a code goes out successfully.
    onSuccess: () => toast.dismiss(),
    onError: (e) => toast.error((e as Error).message),
  });
  const verifyOtpMut = useMutation({
    mutationFn: (code: string) => verifyOtpFn({ data: { token, code } }),
    onSuccess: () => {
      toast.dismiss();
      // Deterministic transition: a full document load of the canonical portal
      // URL. The in-place refetch (refetch context + invalidate ~14 queries
      // while the layout flips gate→Outlet) had a rare router race on first
      // interaction that could momentarily resolve the index route "/" and hit
      // its /auth redirect — a client landing on staff login (finding #4). A
      // hard navigation eliminates the race and always renders the verified
      // portal from a clean SSR with the freshly-set session cookie.
      if (typeof window !== "undefined") {
        window.location.assign(slug ? `/portal/${slug}/${token}` : `/portal/${token}`);
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const concernMut = useMutation({
    mutationFn: (v: { visitId: string | null; category: any; message: string }) =>
      concernFn({ data: { token, ...v } }),
    onSuccess: () => {
      toast.success("Thanks, we'll follow up shortly.");
      invalidatePortal();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  // No success toast: the dialog that asked says thank you itself, in the
  // business's name, and a toast on top of it would say it twice.
  const recleanMut = useMutation({
    mutationFn: (v: { visitId: string; message: string }) => recleanFn({ data: { token, ...v } }),
    onSuccess: () => invalidatePortal(),
    onError: (e) => toast.error((e as Error).message),
  });
  const skipMut = useMutation({
    mutationFn: (v: { visitId: string; reason: string }) => skipFn({ data: { token, ...v } }),
    onSuccess: () => {
      toast.success("Skip requested");
      invalidatePortal();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const rescheduleMut = useMutation({
    mutationFn: (v: { visitId: string; newDate: string }) =>
      rescheduleFn({ data: { token, ...v } }),
    onSuccess: () => {
      toast.success("Visit rescheduled");
      invalidatePortal();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const freqMut = useMutation({
    mutationFn: (v: {
      subscriptionId: string;
      frequency: "weekly" | "biweekly" | "twice_weekly" | "monthly";
    }) => changeFreqFn({ data: { token, ...v } }),
    onSuccess: (r: any) => {
      toast.success(
        r?.status === "requested"
          ? "Change request sent. The office will review it."
          : "Plan updated",
      );
      invalidatePortal();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const subscribeAddonMut = useMutation({
    mutationFn: (v: {
      addonServiceId: string;
      frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" | null;
      quantity: number;
      propertyId?: string | null;
    }) => subscribeAddonFn({ data: { token, ...v } }),
    onSuccess: () => {
      // Portal add-ons are REQUESTS now: nothing bills until staff approve.
      toast.success("Request sent. We'll confirm it shortly.");
      invalidatePortal();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const cancelAddonMut = useMutation({
    mutationFn: (addonSubscriptionId: string) =>
      cancelAddonFn({ data: { token, addonSubscriptionId } }),
    onSuccess: () => {
      toast.success("Add-on canceled");
      invalidatePortal();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const setAutopayMut = useMutation({
    mutationFn: (enabled: boolean) => setAutopayFn({ data: { token, enabled } }),
    onSuccess: (r) => {
      toast.success(r.enabled ? "Autopay on" : "Autopay off");
      invalidatePortal();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const removeCardMut = useMutation({
    mutationFn: () => removeCardFn({ data: { token } }),
    onSuccess: () => {
      toast.success("Card removed");
      invalidatePortal();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const paySavedMut = useMutation({
    mutationFn: (invoiceId: string) => payWithSavedFn({ data: { token, invoiceId } }),
    onSuccess: () => {
      toast.success("Payment submitted");
      invalidatePortal();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const vacationMut = useMutation({
    mutationFn: (v: { startDate: string; endDate: string; reason: string }) =>
      vacationFn({ data: { token, ...v } }),
    onSuccess: (r) => {
      toast.success(
        r.skippedCount > 0
          ? `${r.skippedCount} visit${r.skippedCount === 1 ? "" : "s"} skipped for your vacation`
          : "Vacation hold sent to the office for review",
      );
      invalidatePortal();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const promoMut = useMutation({
    mutationFn: (code: string) => promoFn({ data: { token, code } }),
    onSuccess: (r) => {
      toast.success(`${money(r.creditCents)} credit added to your account`);
      invalidatePortal();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return {
    token,
    slug: slug ?? "",
    signPhotosFn,
    contextQ,
    verified,
    requestOtpMut,
    verifyOtpMut,
    clientQ,
    visitsQ,
    invoicesQ,
    subsQ,
    catalogQ,
    clientAddonsQ,
    historyQ,
    dogsQ,
    referralQ,
    stationsQ,
    requestsQ,
    concernMut,
    recleanMut,
    skipMut,
    rescheduleMut,
    freqMut,
    subscribeAddonMut,
    cancelAddonMut,
    setAutopayMut,
    removeCardMut,
    paySavedMut,
    vacationMut,
    promoMut,
    invalidatePortal,
  };
}

/* ───────────────── verify / sign-in (always company-branded) ───────────── */

type Branding = {
  orgName: string;
  orgSlug: string | null;
  logoUrl: string | null;
  brandColor: string | null;
} | null;

/** Branded wrapper used by BOTH the verify gate and the generic sign-in page,
 *  so no unbranded portal page exists anywhere. */
function PortalBrandedShell({
  branding,
  children,
  footer = "Trouble getting the code? Call or text us and we can read it to you.",
}: {
  branding: Branding;
  children: React.ReactNode;
  /** The verify flow's line is about codes; a dead-end page needs its own. */
  footer?: React.ReactNode;
}) {
  const brand =
    branding && isHex(branding.brandColor) ? (branding.brandColor as string) : "#16a34a";
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <div className="mb-5 flex flex-col items-center text-center">
        {branding?.logoUrl ? (
          <img
            src={branding.logoUrl}
            alt={branding.orgName}
            className="h-14 w-14 rounded-xl object-contain"
            style={{ background: `${brand}14` }}
          />
        ) : (
          <div
            className="flex h-14 w-14 items-center justify-center rounded-xl text-xl font-bold text-white"
            style={{ background: brand }}
          >
            {(branding?.orgName ?? "•").slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="mt-2 text-lg font-semibold">{branding?.orgName ?? "Client portal"}</div>
      </div>
      <div
        className="rounded-2xl border bg-card p-(--card-pad) shadow-sm"
        style={{ borderTopColor: brand, borderTopWidth: 3 }}
      >
        {children}
      </div>
      {footer ? <p className="mt-4 text-center text-xs text-muted-foreground">{footer}</p> : null}
    </div>
  );
}

/**
 * Every way the portal can stop working, in the same branded card as the rest
 * of it.
 *
 * The comment on PortalBrandedShell says "no unbranded portal page exists
 * anywhere". Four did: the route's errorComponent, its notFoundComponent, and
 * the two inline bail-outs in the shell. They rendered a bare centred div —
 * and the error one printed `error.message` straight at the customer, which is
 * whatever Postgres or fetch said. A homeowner reading
 * "JWT expired: token is expired by 3h2m" learns nothing they can act on and
 * has no idea who the page belongs to.
 *
 * The technical text is kept, behind a disclosure, because the person on the
 * phone to support needs it and hiding it entirely just moves the dead end.
 */
export function PortalDeadEnd({
  branding = null,
  title,
  body,
  detail,
}: {
  branding?: Branding;
  title: string;
  body: React.ReactNode;
  /** Raw error text. Shown collapsed, never as the headline. */
  detail?: string | null;
}) {
  return (
    <PortalBrandedShell
      branding={branding}
      footer="If this keeps happening, call or text us, and we can sort it out in a minute."
    >
      <h1 className="text-center text-lg font-semibold">{title}</h1>
      <div className="mt-2 text-center text-sm text-muted-foreground">{body}</div>
      {detail ? (
        <details className="mt-4 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Technical details</summary>
          <p className="mt-1 break-words font-mono text-2xs">{detail}</p>
        </details>
      ) : null}
    </PortalBrandedShell>
  );
}

/** The 6-digit code input + verify/resend/back controls, shared by both flows. */
function CodeEntry({
  sentHint,
  pending,
  onVerify,
  onResend,
  onBack,
  resending,
}: {
  sentHint?: string | null;
  pending: boolean;
  onVerify: (code: string) => void;
  onResend?: () => void;
  onBack?: () => void;
  resending?: boolean;
}) {
  const [code, setCode] = useState("");
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {sentHint
          ? `We sent a 6-digit code to ${sentHint}. Enter it below.`
          : "Enter the 6-digit code we gave you."}
      </p>
      <Input
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder="123456"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        className="text-center text-lg tracking-[0.3em]"
      />
      <Button
        className="w-full"
        disabled={pending || code.length < 6}
        onClick={() => onVerify(code)}
      >
        {pending ? "Verifying…" : "Verify"}
      </Button>
      <div className="flex justify-between text-xs text-muted-foreground">
        {onBack ? (
          <button className="hover:underline" onClick={onBack}>
            ← Back
          </button>
        ) : (
          <span />
        )}
        {onResend ? (
          <button
            className="hover:underline disabled:opacity-50"
            disabled={resending}
            onClick={onResend}
          >
            Resend code
          </button>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}

/** Channel picker ("text me" / "email me") + the "already have a code" path. */
function ChannelChooser({
  channels,
  channel,
  setChannel,
  onSend,
  sending,
  onHaveCode,
}: {
  channels: Array<{ channel: "sms" | "email"; hint: string }>;
  channel: "sms" | "email";
  setChannel: (c: "sms" | "email") => void;
  onSend: () => void;
  sending: boolean;
  onHaveCode: () => void;
}) {
  return (
    <div className="space-y-3">
      {channels.map((c) => (
        <button
          key={c.channel}
          onClick={() => setChannel(c.channel)}
          className={`flex w-full items-center justify-between rounded-lg border p-3 text-left text-sm ${
            channel === c.channel ? "border-primary ring-1 ring-primary" : ""
          }`}
        >
          <span>{c.channel === "sms" ? "Text me a code" : "Email me a code"}</span>
          <span className="text-muted-foreground">{c.hint}</span>
        </button>
      ))}
      <Button className="w-full" disabled={sending} onClick={onSend}>
        {sending ? "Sending…" : "Send code"}
      </Button>
      {/* The other way in, for someone who already has the code from a text.
          It was a 16px line of type -- the smallest control in the product,
          on the page every portal customer sees first. */}
      <button
        className="w-full text-center text-xs text-muted-foreground hover:underline touch:min-h-11"
        onClick={onHaveCode}
      >
        Already have a code from us? Enter it
      </button>
    </div>
  );
}

/** Deep-link verify gate: client is pre-identified by the token. Branded. */
export function PortalVerifyGate() {
  const { contextQ, requestOtpMut, verifyOtpMut } = usePortalCtx();
  const [step, setStep] = useState<"choose" | "code">("choose");
  const [channel, setChannel] = useState<"sms" | "email">("sms");

  const ctx = contextQ.data as any;
  const branding: Branding = ctx?.branding ?? null;
  const channels: Array<{ channel: "sms" | "email"; hint: string }> = ctx?.channels ?? [];

  useEffect(() => {
    if (channels.length && !channels.some((c) => c.channel === channel))
      setChannel(channels[0].channel);
  }, [channels, channel]);

  return (
    <PortalBrandedShell branding={branding}>
      <h1 className="text-xl font-semibold">Verify it's you</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        For your security, we'll send a one-time code to the contact on file before showing your
        account.
      </p>
      <div className="mt-5">
        {channels.length === 0 ? (
          <div className="space-y-3">
            <p className="rounded-md bg-muted p-3 text-sm">
              We don't have a phone or email on file to text or email you a code. Call or text us
              and we can read you a code to enter here.
            </p>
            <CodeEntry pending={verifyOtpMut.isPending} onVerify={(c) => verifyOtpMut.mutate(c)} />
          </div>
        ) : step === "choose" ? (
          <ChannelChooser
            channels={channels}
            channel={channel}
            setChannel={setChannel}
            sending={requestOtpMut.isPending}
            onSend={() => requestOtpMut.mutate(channel, { onSuccess: () => setStep("code") })}
            onHaveCode={() => setStep("code")}
          />
        ) : (
          <CodeEntry
            sentHint={requestOtpMut.data?.hint}
            pending={verifyOtpMut.isPending}
            resending={requestOtpMut.isPending}
            onVerify={(c) => verifyOtpMut.mutate(c)}
            onResend={() => requestOtpMut.mutate(channel)}
            onBack={() => setStep("choose")}
          />
        )}
      </div>
    </PortalBrandedShell>
  );
}

/** Generic company sign-in (/portal/{slug}): identify → OTP → (picker) → portal. */
export function PortalGenericEntry({ slug }: { slug: string }) {
  const navigate = useNavigate();
  const orgFn = useServerFn(portalOrgBySlug);
  const identifyFn = useServerFn(portalIdentify);
  const verifyFn = useServerFn(portalVerifyGenericOtp);
  const chooseFn = useServerFn(portalChooseAccount);
  const redeemFn = useServerFn(portalRedeemCode);

  const [contact, setContact] = useState("");
  const [step, setStep] = useState<"identify" | "code" | "pick" | "haveCode">("identify");
  const [candidates, setCandidates] = useState<Array<{ id: string; label: string }>>([]);

  const orgQ = useQuery({
    queryKey: ["portal-org", slug],
    queryFn: () => orgFn({ data: { slug } }),
    retry: false,
  });
  const org = orgQ.data as any;
  const branding: Branding = org?.found ? org.branding : null;
  // A code is texted only by a business with its own texting number; the
  // rest sign in by email, and the form does not ask for a phone it can't use.
  const textCodes = org?.found ? org.textCodes === true : false;

  const goToPortal = (s: string, token: string) =>
    navigate({ to: "/portal/$slug/$token", params: { slug: s || slug, token } });

  const identifyMut = useMutation({
    mutationFn: () => identifyFn({ data: { slug, contact } }),
    // Clear any lingering failed-attempt toast so the path that works isn't
    // shadowed by the one that didn't (P0.5).
    onSuccess: () => {
      toast.dismiss();
      setStep("code");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const verifyMut = useMutation({
    mutationFn: (code: string) => verifyFn({ data: { slug, contact, code } }),
    onSuccess: (r: any) => {
      toast.dismiss();
      if (r.status === "verified") goToPortal(r.slug, r.token);
      else {
        setCandidates(r.candidates);
        setStep("pick");
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const chooseMut = useMutation({
    mutationFn: (clientId: string) => chooseFn({ data: { clientId } }),
    onSuccess: (r: any) => goToPortal(r.slug, r.token),
    onError: (e) => toast.error((e as Error).message),
  });
  const redeemMut = useMutation({
    mutationFn: (code: string) => redeemFn({ data: { slug, code } }),
    onSuccess: (r: any) => goToPortal(r.slug, r.token),
    onError: (e) => toast.error((e as Error).message),
  });

  if (orgQ.isLoading) {
    return (
      <div className="mx-auto max-w-md p-8 text-center text-sm text-muted-foreground">Loading…</div>
    );
  }
  if (!org?.found) {
    return (
      <PortalBrandedShell branding={null}>
        <h1 className="text-xl font-semibold">Company not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This sign-in link doesn't match a company. Double-check the address, or contact your
          service provider.
        </p>
      </PortalBrandedShell>
    );
  }

  return (
    <PortalBrandedShell branding={branding}>
      {step === "identify" && (
        <>
          <h1 className="text-xl font-semibold">Sign in to your portal</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {textCodes
              ? "Enter the phone number or email on your account and we'll send you a one-time code."
              : "Enter the email on your account and we'll send you a one-time code."}
          </p>
          <form
            className="mt-5 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (contact.trim()) identifyMut.mutate();
            }}
          >
            <Input
              type="text"
              inputMode="email"
              autoComplete="email"
              placeholder={textCodes ? "you@example.com or (555) 123-4567" : "you@example.com"}
              value={contact}
              onChange={(e) => setContact(e.target.value)}
            />
            <Button
              type="submit"
              className="w-full"
              disabled={identifyMut.isPending || !contact.trim()}
            >
              {identifyMut.isPending ? "Sending…" : "Send code"}
            </Button>
          </form>
          <button
            className="mt-3 w-full text-center text-xs text-muted-foreground hover:underline touch:min-h-11"
            onClick={() => setStep("haveCode")}
          >
            Already have a code from us? Enter it
          </button>
        </>
      )}

      {step === "haveCode" && (
        <>
          <h1 className="text-xl font-semibold">Enter your code</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Enter the code we gave you and we'll open your account.
          </p>
          <div className="mt-5">
            <CodeEntry
              pending={redeemMut.isPending}
              onVerify={(c) => redeemMut.mutate(c)}
              onBack={() => setStep("identify")}
            />
          </div>
        </>
      )}

      {step === "code" && (
        <>
          <h1 className="text-xl font-semibold">Verify it's you</h1>
          <div className="mt-5">
            <CodeEntry
              sentHint={(identifyMut.data as any)?.hint}
              pending={verifyMut.isPending}
              resending={identifyMut.isPending}
              onVerify={(c) => verifyMut.mutate(c)}
              onResend={() => identifyMut.mutate()}
              onBack={() => setStep("identify")}
            />
          </div>
        </>
      )}

      {step === "pick" && (
        <>
          <h1 className="text-xl font-semibold">Choose your account</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            More than one account uses that contact. Pick which one to open.
          </p>
          <div className="mt-5 space-y-2">
            {candidates.map((c) => (
              <button
                key={c.id}
                disabled={chooseMut.isPending}
                onClick={() => chooseMut.mutate(c.id)}
                className="flex w-full items-center justify-between rounded-lg border p-3 text-left text-sm hover:border-primary disabled:opacity-50"
              >
                <span>{c.label}</span>
                <span className="text-muted-foreground">Open →</span>
              </button>
            ))}
          </div>
        </>
      )}
    </PortalBrandedShell>
  );
}

/* ───────────────────────── context ───────────────────────── */

type PortalCtx = ReturnType<typeof usePortal>;
const PortalContext = createContext<PortalCtx | null>(null);

export function PortalProvider({
  token,
  slug,
  children,
}: {
  token: string;
  slug?: string;
  children: React.ReactNode;
}) {
  const portal = usePortal(token, slug);
  return <PortalContext.Provider value={portal}>{children}</PortalContext.Provider>;
}

export function usePortalCtx(): PortalCtx {
  const v = useContext(PortalContext);
  if (!v) throw new Error("usePortalCtx must be used inside <PortalProvider>");
  return v;
}

/**
 * The ORGANIZATION's timezone, for portal components that print an instant
 * (`orgLocalTime` / `fmtCutoff`). The portal twin of `useOrgTimezone()` in
 * useOrgToday.ts, and a hook rather than a prop for the same reason given
 * there: threading `tz` through every row component means every future
 * consumer has to remember to pass it, and forgetting silently reintroduces
 * device-local rendering — the failure mode this exists to fix.
 *
 * The portal has no staff session, so the zone can't come from `getMyOrg`; it
 * rides on the branding that `portalContext` already returns on every load
 * (verified or not), widened in portal-auth.server.ts. By the time anything
 * that prints a time renders, the verify gate has already resolved that query,
 * so this adds no fetch. Falls back to the same SQL column default as
 * org-day.ts rather than to the device — a wrong-but-stable clock beats one
 * that changes with whoever is reading.
 */
export function usePortalTimezone(): string {
  const { contextQ } = usePortalCtx();
  const branding = (contextQ.data as { branding?: { timezone?: string | null } | null } | undefined)
    ?.branding;
  return branding?.timezone || DEFAULT_ORG_TIMEZONE;
}

/* ────────────────────────── reusable UI ───────────────────────── */

export function EmptyBox({
  icon,
  title,
  body,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
}) {
  return (
    <div className="rounded-md border border-dashed bg-card/50 p-6 text-center">
      {icon && <div className="mx-auto mb-2 text-muted-foreground">{icon}</div>}
      <div className="font-medium">{title}</div>
      {body && <p className="mt-1 text-sm text-muted-foreground">{body}</p>}
    </div>
  );
}

export function InvoiceStatusBadge({ status }: { status: string }) {
  if (status === "paid") return <Badge className="bg-emerald-600 hover:bg-emerald-600">Paid</Badge>;
  if (status === "void") return <Badge variant="outline">Void</Badge>;
  if (status === "draft") return <Badge variant="secondary">Draft quote</Badge>;
  // Written-off — don't show it to the client as still "Open" (it isn't
  // payable), and don't scare them with internal jargon either.
  if (status === "uncollectible") return <Badge variant="outline">Closed</Badge>;
  return (
    <Badge
      className="border-transparent bg-blue-500/15 text-blue-700 hover:bg-blue-500/15 dark:text-blue-400"
      variant="secondary"
    >
      Open
    </Badge>
  );
}

export function UpcomingVisitsList({
  rows,
  allowReschedule,
  skipBillablePct = 0,
  onSkip,
  onReschedule,
}: {
  rows: Array<any>;
  allowReschedule: boolean;
  /** Percentage of the visit price a portal skip still bills. See VisitRow. */
  skipBillablePct?: number;
  onSkip: (id: string, reason: string) => void;
  onReschedule: (id: string, newDate: string) => void;
}) {
  const addresses = new Set(rows.map((r) => `${r.street}|${r.city}|${r.postal_code}`));
  const sharedAddress = addresses.size === 1 && rows[0]?.street ? rows[0] : null;
  return (
    <>
      {sharedAddress && (
        <p className="mb-2 text-xs text-muted-foreground inline-flex items-center gap-1">
          <MapPin className="h-3 w-3 shrink-0" />
          {[sharedAddress.street, sharedAddress.city, sharedAddress.postal_code]
            .filter(Boolean)
            .join(", ")}
        </p>
      )}
      <ul className="divide-y rounded-md border bg-card">
        {rows.map((v) => (
          <VisitRow
            key={v.visit_id}
            v={v}
            showAddress={!sharedAddress}
            allowReschedule={allowReschedule}
            skipBillablePct={skipBillablePct}
            onSkip={(reason) => onSkip(v.visit_id, reason)}
            onReschedule={(d) => onReschedule(v.visit_id, d)}
          />
        ))}
      </ul>
    </>
  );
}

function VisitRow({
  v,
  showAddress,
  allowReschedule,
  skipBillablePct = 0,
  onSkip,
  onReschedule,
}: {
  v: any;
  showAddress: boolean;
  allowReschedule: boolean;
  /** The org's `customer_requested` skip-billing percentage, 0–100. Zero on a
   *  default org, and zero is the honest majority case — see the note by the
   *  copy below. */
  skipBillablePct?: number;
  onSkip: (reason: string) => void;
  onReschedule: (newDate: string) => void;
}) {
  const tz = usePortalTimezone();
  const [skipOpen, setSkipOpen] = useState(false);
  const [reschedOpen, setReschedOpen] = useState(false);
  const [reason, setReason] = useState("");
  // Tomorrow on the BUSINESS's calendar, which is what portal_reschedule_visit
  // refuses against. The device's UTC day offered a day the server then
  // refused, every evening west of Greenwich (#654).
  const orgDay = orgToday(tz);
  const minDate = shiftDay(orgDay, 1);
  const maxDate = shiftDay(orgDay, 60);
  const [newDate, setNewDate] = useState(minDate);

  // The deadline is the server's. It used to be derived here — the visit date
  // read at the BROWSER's midnight, less the org's cutoff hours — which is a
  // different instant for a customer who is travelling, and which the RPCs
  // then enforced not at all: both accepted a skip or a reschedule long past
  // the cutoff, and one accepted a skip of a visit the tech had already
  // started. `portal_list_upcoming_visits` now returns
  // `changes_allowed_until`, computed by `portal_change_deadline` in the ORG's
  // timezone, and the same function is what the writers refuse against. See
  // 20260812120000_the-portal-cutoff-was-only-a-hidden-button.sql.
  //
  // Comparing two instants, so no timezone is involved in `pastCutoff` at all.
  // The PRINTED copy is org-local with the zone named — `fmtCutoff` up top
  // carries the adjudication of the device-local rendering this replaces.
  const cutoff = v.changes_allowed_until ? new Date(v.changes_allowed_until) : null;
  const pastCutoff = cutoff ? Date.now() > cutoff.getTime() : false;

  const cutoffCopy = cutoff
    ? `Changes allowed until ${fmtCutoff(v.changes_allowed_until, tz)}.`
    : "";

  return (
    <li className="p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">{fmtDay(v.scheduled_on)}</div>
          <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-2">
            {v.eta_start && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3 shrink-0" /> arriving {orgLocalTime(v.eta_start, tz)}–
                {orgLocalTime(v.eta_end, tz)}
              </span>
            )}
            {/* A walk not routed yet shows its plan's window (#410). */}
            {!v.eta_start && v.walk_window && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3 shrink-0" /> {v.walk_window}
              </span>
            )}
            {relativeFromToday(v.scheduled_on) && (
              <span>· {relativeFromToday(v.scheduled_on)}</span>
            )}
            {v.tech_name && (
              <span>
                · with <strong>{v.tech_name}</strong>
              </span>
            )}
            {showAddress && (v.street || v.city) && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3 shrink-0" />{" "}
                {[v.street, v.city].filter(Boolean).join(", ")}
              </span>
            )}
          </div>
          {v.weather_flagged && (
            <div className="mt-1 inline-flex items-center gap-1 rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-800">
              <CloudRain className="h-3 w-3 shrink-0" />{" "}
              {v.weather_note ?? "Weather may affect this visit"}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {allowReschedule && !pastCutoff && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setReschedOpen((o) => !o);
                setSkipOpen(false);
              }}
            >
              {reschedOpen ? "Cancel" : "Reschedule"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={pastCutoff}
            title={pastCutoff ? "Past the change cutoff. Text the office" : undefined}
            onClick={() => {
              setSkipOpen((o) => !o);
              setReschedOpen(false);
            }}
          >
            {skipOpen ? "Cancel" : "Skip"}
          </Button>
        </div>
      </div>

      {/* Two things were wrong with the single line this replaces —
          "{cutoffCopy} A skipped visit may still be billable per your
          agreement." — and they pulled in opposite directions.

          It was shown on RESCHEDULE as well as on skip, because the condition
          is `skipOpen || reschedOpen`. Rescheduling bills nothing:
          portal_reschedule_visit moves scheduled_on, clears the routing, and
          never touches skip_charge_cents — it even refuses a visit that has
          already been invoiced. A customer opening the date picker to move a
          visit two days was told they might be charged for doing it.

          And on skip it was usually false. portal_request_skip multiplies the
          visit price by the org's `customer_requested` percentage, which is 0
          unless an owner deliberately raised it, so on most orgs the charge it
          warns about cannot happen. "May still be billable per your agreement"
          is the kind of hedge that reads as a threat and tells the reader
          nothing they can act on — the point of a cutoff notice is to let
          someone decide, and a maybe-charge of an unstated size does not.

          So: the cutoff line stands on both actions, since the cutoff really
          does govern both; the money line appears only when skipping, only
          when the org charges for it, and says how much. */}
      {(skipOpen || reschedOpen) && (cutoffCopy || (skipOpen && skipBillablePct > 0)) && (
        <p className="mt-2 text-xs text-muted-foreground">
          {[
            // Empty when the server did not send a deadline, which is the only
            // way it can be unknown now. Better a missing sentence than an
            // invented "24h before" that nothing enforces.
            cutoffCopy,
            skipOpen && skipBillablePct > 0
              ? skipBillablePct >= 100
                ? "Skipping this visit is still billed at the full visit price."
                : `Skipping this visit is still billed at ${skipBillablePct}% of the visit price.`
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}

      {reschedOpen && !pastCutoff && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor={`d-${v.visit_id}`} className="text-xs">
              New date
            </Label>
            <Input
              id={`d-${v.visit_id}`}
              type="date"
              min={minDate}
              max={maxDate}
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              className="w-40"
            />
          </div>
          <Button
            size="sm"
            onClick={() => {
              onReschedule(newDate);
              setReschedOpen(false);
            }}
          >
            Confirm reschedule to {fmtDayShort(newDate)}
          </Button>
        </div>
      )}
      {skipOpen && !pastCutoff && (
        <div className="mt-3 space-y-2">
          <Label htmlFor={`r-${v.visit_id}`} className="text-xs">
            Reason (optional)
          </Label>
          <Input
            id={`r-${v.visit_id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Out of town, etc."
          />
          <Button
            size="sm"
            onClick={() => {
              onSkip(reason);
              setSkipOpen(false);
              setReason("");
            }}
          >
            Confirm skip {fmtDayShort(v.scheduled_on)}
          </Button>
        </div>
      )}
    </li>
  );
}

export function PlanRow({
  s,
  isCommercial,
  allowChange,
  autoApply,
  onChange,
  pending,
}: {
  s: {
    subscription_id: string;
    frequency: string;
    property_label: string | null;
    price_cents: number;
    /** The days a walk plan runs on (the catalog); absent or null otherwise. */
    weekdays?: number[] | null;
  };
  isCommercial: boolean;
  allowChange: boolean;
  autoApply: boolean;
  onChange: (f: "weekly" | "biweekly" | "twice_weekly" | "monthly") => void;
  pending: boolean;
}) {
  const [freq, setFreq] = useState<string>(s.frequency);
  return (
    <li className="rounded-md border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <div className="font-medium">
            {s.property_label ?? (isCommercial ? "Service contract" : "Weekly service")}
          </div>
          <div className="text-xs text-muted-foreground">
            Currently {cadenceLabel(s.frequency, s.weekdays)} · {money(s.price_cents)}/visit
          </div>
        </div>
        {allowChange && (
          <>
            <div>
              <Label className="text-xs">Change frequency</Label>
              <Select value={freq} onValueChange={setFreq}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                  <SelectItem value="twice_weekly">Twice weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              size="sm"
              disabled={pending || freq === s.frequency}
              onClick={() => onChange(freq as any)}
            >
              {autoApply ? "Update plan" : "Request change"}
            </Button>
          </>
        )}
      </div>
      {allowChange && !autoApply && (
        <p className="mt-2 text-xs text-muted-foreground">
          Frequency changes are reviewed by the office before they take effect. We'll confirm within
          one business day.
        </p>
      )}
    </li>
  );
}

export function VacationHoldCard({
  autoApply,
  onSubmit,
  pending,
}: {
  autoApply: boolean;
  onSubmit: (v: { startDate: string; endDate: string; reason: string }) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Tomorrow on the business's calendar, as the reschedule picker above.
  const min = shiftDay(orgToday(usePortalTimezone()), 1);
  const [start, setStart] = useState(min);
  const [end, setEnd] = useState(min);
  const [reason, setReason] = useState("");
  return (
    <div className="rounded-md border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PalmtreeIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          <div>
            <div className="font-medium">Vacation hold</div>
            <div className="text-xs text-muted-foreground">Skip service while you're away.</div>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
          {open ? "Cancel" : "Request hold"}
        </Button>
      </div>
      {open && (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <div>
            <Label className="text-xs">From</Label>
            <Input type="date" min={min} value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Through</Label>
            <Input type="date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <div className="sm:col-span-3">
            <Label className="text-xs">Note for the office (optional)</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Beach week"
            />
          </div>
          <div className="sm:col-span-3 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {autoApply
                ? "Visits in this range will be skipped immediately."
                : "The office will confirm and skip the affected visits within one business day."}
            </p>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => onSubmit({ startDate: start, endDate: end, reason })}
            >
              {pending ? "Submitting…" : autoApply ? "Skip these visits" : "Request hold"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function DogsGrid({ rows }: { rows: any[] }) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {rows.map((d) => (
        <li key={d.dog_id} className="rounded-md border bg-card p-3 text-sm">
          <div className="font-medium">{d.name}</div>
          <div className="text-xs text-muted-foreground">
            {[d.breed, d.weight_class].filter(Boolean).join(" · ") || "No breed on file"}
          </div>
          {d.temperament && (
            <Badge variant="outline" className="mt-2 text-3xs capitalize">
              {d.temperament}
            </Badge>
          )}
          {d.notes && <p className="mt-2 text-xs text-muted-foreground">{d.notes}</p>}
        </li>
      ))}
    </ul>
  );
}

export function StationsPanel({ rows }: { rows: Array<any> }) {
  if (rows.length === 0)
    return (
      <EmptyBox
        icon={<Trash2 className="h-6 w-6 shrink-0" />}
        title="No stations set up yet"
        body="Once we install stations at your property they'll be listed here."
      />
    );
  return (
    <ul className="divide-y rounded-md border bg-card">
      {rows.map((s) => (
        <li key={s.station_id} className="p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              {/* The same helper the office and the field use. `label` is
                  nullable since BUG-10, so rendering it alone put a blank
                  heading above a location description belonging to nothing —
                  and the number is how the crew refers to the bin on the
                  phone. */}
              <div className="font-medium break-words">
                {stationDisplayName(s.station_number, s.label)}
              </div>
              {s.location_description && (
                <div className="text-xs text-muted-foreground break-words">
                  {s.location_description}
                </div>
              )}
            </div>
            {/* Capacity used to print here from `capacity_liners`, which
                stations.functions.ts stopped writing in QA round 8 and the
                staff editor stopped showing. A number nobody can change reads
                as current, so it is gone rather than stale. */}
            <div className="shrink-0 text-xs text-muted-foreground text-right">
              <div>Last serviced: {s.last_serviced_on ? fmtDayShort(s.last_serviced_on) : "-"}</div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function AddonCard({
  a,
  onSubscribe,
  pending,
  properties = [],
}: {
  a: any;
  onSubscribe: (
    freq: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" | null,
    qty: number,
    propertyId: string | null,
  ) => void;
  pending: boolean;
  properties?: Array<{ id: string; label?: string | null; street?: string | null }>;
}) {
  const [qty, setQty] = useState(1);
  const [freq, setFreq] = useState<string>(a.default_frequency ?? "monthly");
  // Finding #29: when the client has 2+ properties, let them pick which one an
  // add-on applies to (default = first). One-property clients see no selector.
  const multiProp = properties.length > 1;
  const [propertyId, setPropertyId] = useState<string>(properties[0]?.id ?? "");
  const isRecurring = a.kind === "recurring";
  return (
    <li className="rounded-md border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[12rem]">
          <div className="font-medium">{a.name}</div>
          {a.description && <div className="text-xs text-muted-foreground">{a.description}</div>}
          <div className="mt-1 text-xs text-muted-foreground">
            <strong>{money(a.unit_price_cents)}</strong> · {isRecurring ? "recurring" : "one-time"}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {multiProp && (
            <div>
              <Label className="text-xs">Property</Label>
              <Select value={propertyId} onValueChange={setPropertyId}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {properties.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label || p.street || "Property"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label className="text-xs">Qty</Label>
            <Input
              type="number"
              min={1}
              max={50}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              className="w-20"
            />
          </div>
          {isRecurring && (
            <div>
              <Label className="text-xs">Frequency</Label>
              <Select value={freq} onValueChange={setFreq}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              onSubscribe(
                isRecurring ? (freq as any) : null,
                qty,
                multiProp ? propertyId || null : null,
              )
            }
          >
            {isRecurring ? "Subscribe" : "Add"}
          </Button>
        </div>
      </div>
    </li>
  );
}

export function TopupRow({
  s,
  onSubmit,
  pending,
}: {
  s: {
    subscription_id: string;
    price_cents: number;
    frequency: string;
    property_label: string | null;
    weekdays?: number[] | null;
  };
  onSubmit: (count: number) => void;
  pending: boolean;
}) {
  const [count, setCount] = useState(4);
  return (
    <li className="flex flex-wrap items-end gap-3 rounded-md border bg-card p-3 text-sm">
      <div className="flex-1">
        <div className="font-medium">
          {s.property_label ?? "Service"} · {cadenceLabel(s.frequency, s.weekdays)}
        </div>
        <div className="text-xs text-muted-foreground">{money(s.price_cents)} per visit</div>
      </div>
      <div>
        <Label htmlFor={`n-${s.subscription_id}`} className="text-xs">
          Visits
        </Label>
        <Input
          id={`n-${s.subscription_id}`}
          type="number"
          min={1}
          max={52}
          value={count}
          onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
          className="w-24"
        />
      </div>
      <div className="text-sm font-medium">= {money(count * s.price_cents)}</div>
      <Button size="sm" disabled={pending} onClick={() => onSubmit(count)}>
        Pay & top up
      </Button>
    </li>
  );
}

export function PromoRedeemCard({
  onSubmit,
  pending,
}: {
  onSubmit: (code: string) => void;
  pending: boolean;
}) {
  const [code, setCode] = useState("");
  return (
    <div className="rounded-md border bg-card p-3 text-sm">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">Promo or gift code</p>
      <div className="mt-2 flex gap-2">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Enter code"
          className="uppercase"
        />
        <Button
          size="sm"
          disabled={pending || !code.trim()}
          onClick={() => {
            onSubmit(code.trim());
            setCode("");
          }}
        >
          {pending ? "Applying…" : "Apply"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Credit is added to your account and applied to your next invoice automatically.
      </p>
    </div>
  );
}

export function ServiceHistorySection({
  rows,
  signPhotos,
  token,
  onReport,
  reporting,
  reclean,
  petWaste = true,
}: {
  rows: Array<any>;
  signPhotos: (args: {
    data: { token: string; paths: string[] };
  }) => Promise<{ urls: Record<string, string> }>;
  token: string;
  onReport: (visitId: string, category: string, message: string) => void;
  reporting: boolean;
  /** The re-clean guarantee. Omitted or a window of 0: no offer is drawn. */
  reclean?: {
    windowHours: number;
    businessName: string;
    /** Visits that already have an unresolved re-clean request. */
    requestedVisitIds: Set<string>;
    onRequest: (visitId: string, message: string) => Promise<unknown>;
  };
  /** Whether the business runs pet waste (portalGetClient's pet_waste). Only
   *  decides a visit whose service line could not be read; fails open. */
  petWaste?: boolean;
}) {
  const tz = usePortalTimezone();
  const [urls, setUrls] = useState<Record<string, string>>({});
  // WHICH photo of WHICH visit, rather than one URL string. The bare-URL
  // version could only ever show the single photo that was tapped; a customer
  // looking at a before/after pair had to close and reopen to see the other.
  const [lightbox, setLightbox] = useState<{ visitId: string; index: number } | null>(null);

  // The photos of the visit the viewer is open on, in the order they are shown
  // on the card, so paging in the viewer matches what the customer just saw.
  const lightboxPhotos = useMemo(() => {
    if (!lightbox) return [];
    const row = rows.find((r) => r.visit_id === lightbox.visitId);
    return (row?.photo_paths ?? []).map((path: string, i: number) => ({
      url: urls[path] ?? null,
      kind: photoCaption(row?.photo_kinds?.[i]),
    }));
  }, [lightbox, rows, urls]);

  // Key the signing round-trip on the actual photo paths, not the rows array
  // identity — the query result is a fresh array each settle, and this section
  // now lives on the busy Visits tab where sibling queries re-render it.
  const pathsKey = useMemo(() => rows.flatMap((r) => r.photo_paths ?? []).join("\n"), [rows]);
  useEffect(() => {
    if (!pathsKey) return;
    const paths = pathsKey.split("\n");
    let cancelled = false;
    signPhotos({ data: { token, paths } })
      .then((r) => {
        if (!cancelled) setUrls(r.urls);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathsKey, signPhotos, token]);

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
        <Camera className="h-4 w-4 shrink-0" /> Service history
      </h2>
      {rows.length === 0 ? (
        <EmptyBox
          icon={<Camera className="h-6 w-6 shrink-0" />}
          title="No completed visits yet"
          body="After your first visit, its photos and notes will show here."
        />
      ) : (
        <ul className="space-y-3">
          {/* A dog walk (#410) reads in walk words and offers walk issues; a
              sit, a groom or a lesson (#560) offers visit issues; only a yard
              visit offers yard issues and the re-clean guarantee, which is
              for pet waste. */}
          {rows.map((r) => {
            const yard = isYardVisit(r.service_line, petWaste);
            return (
              <li key={r.visit_id} className="rounded-md border bg-card p-3 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{fmtDay(r.scheduled_on)}</div>
                    <div className="text-xs text-muted-foreground flex flex-wrap gap-2">
                      {r.status === "completed" ? (
                        <>
                          <span className="inline-flex items-center gap-1 text-emerald-700">
                            <CheckCircle2 className="h-3 w-3 shrink-0" />{" "}
                            {isWalkLine(r.service_line) ? "Walk done" : "Completed"}
                            {r.completed_at && <> at {orgLocalTime(r.completed_at, tz)}</>}
                          </span>
                          {r.tech_name && (
                            <span>
                              · by <strong>{r.tech_name}</strong>
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-700">
                          <X className="h-3 w-3 shrink-0" />
                          {/* The reason CODE, phrased for the person whose yard
                            it is. This used to print `skip_reason` -- the free
                            text a technician types at the gate, 1 to 500
                            characters, with nothing marking it internal and
                            nobody writing it thinking about a customer reading
                            it. The office surfaces already prefer the code;
                            the customer got the rawest version in the app.

                            The free text is shown only when the customer wrote
                            it themselves from the portal, which is the one
                            case where the words are their own.

                            A walk says it in walk words, the same sentence
                            the walk-not-done email used. */}
                          {isWalkLine(r.service_line) && r.skip_reason_code !== "customer_requested"
                            ? walkSkipReason(r.skip_reason_code)
                            : customerSkipReason(r.skip_reason_code, yard)}
                          {r.skip_reason_code === "customer_requested" && r.skip_reason && (
                            <>: {r.skip_reason}</>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                  {r.status === "completed" && (
                    <ConcernButton
                      options={
                        isWalkLine(r.service_line)
                          ? WALK_CONCERN_OPTIONS
                          : yard
                            ? CONCERN_OPTIONS
                            : VISIT_CONCERN_OPTIONS
                      }
                      placeholder={
                        yard ? "Tell us what to look for or fix" : "Tell us what happened"
                      }
                      onSubmit={(cat, msg) => onReport(r.visit_id, cat, msg)}
                      pending={reporting}
                    />
                  )}
                </div>

                {reclean &&
                  yard &&
                  (reclean.requestedVisitIds.has(r.visit_id) ? (
                    <p className="mt-2 flex items-start gap-1 text-xs text-emerald-700">
                      <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
                      <span className="min-w-0">
                        Re-clean requested. {reclean.businessName} will be back within the
                        guarantee.
                      </span>
                    </p>
                  ) : (
                    isInsideRecleanWindow(r, reclean.windowHours) && (
                      <RecleanOffer
                        deadline={recleanDeadlineLabel(r.completed_at, reclean.windowHours, tz)}
                        visitDay={fmtDay(r.scheduled_on)}
                        businessName={reclean.businessName}
                        onSubmit={(msg) => reclean.onRequest(r.visit_id, msg)}
                      />
                    )
                  ))}

                {r.status === "completed" && (r.photo_paths?.length ?? 0) === 0 && (
                  <p className="mt-2 text-xs text-muted-foreground italic">
                    {isWalkLine(r.service_line)
                      ? "No photos from this walk."
                      : "Photos not available for this visit."}
                  </p>
                )}

                {(r.photo_paths?.length ?? 0) > 0 && (
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {r.photo_paths.map((p: string, i: number) => (
                      <PortalVisitPhoto
                        key={p}
                        url={urls[p]}
                        kind={r.photo_kinds?.[i]}
                        onOpen={() => urls[p] && setLightbox({ visitId: r.visit_id, index: i })}
                      />
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* THE SAME VIEWER THE FIELD APP USES.
          This was `<div onClick={close} className="fixed inset-0 ...">` with
          an <img> inside it: no
          focus trap, so tabbing walked the page behind it; nothing inert to a
          screen reader; no Escape; and because the close handler sat on the
          parent, a click on the PHOTO closed it too, so a customer could not
          tap their own before-and-after without dismissing it.
          PhotoLightbox is the component My Day got in #203, and sharing it is
          the point -- two spellings of "show this photo" is how the one with
          fewer users stays the worse one. */}
      <PhotoLightbox
        photos={lightboxPhotos}
        openIndex={lightbox ? lightbox.index : null}
        onClose={() => setLightbox(null)}
      />
    </section>
  );
}

/** What a CUSTOMER calls this photo.
 *
 *  `completion` is what the field app writes for the photo that proves the work
 *  is done, and "After" is what the person paying for it calls that. An unknown
 *  kind gets no caption rather than a guessed one.
 *
 *  At module scope because the thumbnail and the full-size viewer both show it,
 *  and a customer tapping "After" must not be shown a heading that says
 *  "completion". It was inline in the thumbnail when the viewer had no caption
 *  at all to disagree with. */
export function photoCaption(kind?: string | null): string | null {
  return kind === "before"
    ? "Before"
    : kind === "completion"
      ? "After"
      : kind === "issue"
        ? "Issue"
        : kind === "gate"
          ? "Gate latched"
          : null;
}

/** One photo on a customer's visit card.
 *
 *  Two things it does that the inline markup did not.
 *
 *  It labels the photo by what it IS. The caption used to be
 *  `i % 2 === 0 ? "Before" : "After"` — the position in the array — while
 *  `visit_photos.kind` sat populated in the database and written explicitly by
 *  the field app. Any odd number of photos mislabelled everything after the
 *  gap; two photos of the same kind mislabelled each other; and an `issue`
 *  photo, taken to document a problem, was served to the customer captioned as
 *  a routine before-and-after.
 *
 *  And it has a third state. A signed URL that 404s rendered the browser's
 *  broken-image glyph to a paying customer, and no URL at all rendered
 *  `animate-pulse` — a skeleton with no timeout behind it, pulsing for ever.
 *  My Day's own PhotoThumb has had the loading / loaded / unavailable split
 *  for a while; this is the same shape, on the screen a customer sees. */
function PortalVisitPhoto({
  url,
  kind,
  onOpen,
}: {
  url?: string;
  kind?: string;
  onOpen: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const caption = photoCaption(kind);
  return (
    <button
      onClick={onOpen}
      disabled={!url || broken}
      className="group relative aspect-square overflow-hidden rounded border bg-muted"
    >
      {url && !broken ? (
        <>
          <img
            src={url}
            alt={caption ? `${caption} photo of your visit` : "Photo of your visit"}
            loading="lazy"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover transition group-hover:scale-105"
          />
          {caption && (
            <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-3xs font-medium uppercase text-white">
              {caption}
            </span>
          )}
        </>
      ) : broken ? (
        <span className="flex h-full w-full items-center justify-center px-1 text-center text-3xs text-muted-foreground">
          Photo unavailable
        </span>
      ) : (
        <div className="h-full w-full animate-pulse bg-muted" />
      )}
    </button>
  );
}

const CONCERN_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "missed_spot", label: "Missed spot" },
  { value: "gate_left_open", label: "Gate left open" },
  { value: "damage", label: "Damage to yard/property" },
  { value: "wrong_yard", label: "Wrong yard serviced" },
  { value: "other", label: "Other" },
];

/** Report on one visit. A walk passes WALK_CONCERN_OPTIONS (walk-concerns.ts):
 *  no missed spot and no wrong yard on a walk. */
function ConcernButton({
  options,
  placeholder,
  onSubmit,
  pending,
}: {
  options: Array<{ value: string; label: string }>;
  placeholder: string;
  onSubmit: (cat: string, msg: string) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState(options[0].value);
  const [msg, setMsg] = useState("");
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Report
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report a concern</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">What happened?</Label>
              <Select value={cat} onValueChange={setCat}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Details (optional)</Label>
              <Textarea
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                rows={3}
                placeholder={placeholder}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              We usually respond within one business day.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                onSubmit(cat, msg);
                setOpen(false);
                setMsg("");
              }}
            >
              {pending ? "Sending…" : "Send to the office"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * "Request a re-clean", on a completed visit still inside the business's
 * guarantee.
 *
 * Its own row under the visit rather than a second button beside "Report":
 * two buttons and a date on one line do not fit a 360px phone, and this one
 * carries a sentence the customer needs, which is how long they have. The
 * deadline is on the ORG's clock with the weekday, like every other time in
 * the portal.
 *
 * The thank-you is drawn in the dialog, in the business's name, after the
 * server has actually accepted the request — not on click.
 */
function RecleanOffer({
  deadline,
  visitDay,
  businessName,
  onSubmit,
}: {
  deadline: string;
  visitDay: string;
  businessName: string;
  onSubmit: (message: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const close = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setState("idle");
      setMsg("");
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed bg-muted/30 p-2">
      <p className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">
        Something missed? This visit is covered by our re-clean guarantee
        {deadline ? ` until ${deadline}` : ""}.
      </p>
      <Button
        size="sm"
        variant="outline"
        className="min-h-11 max-sm:w-full"
        onClick={() => setOpen(true)}
      >
        Request a re-clean
      </Button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {state === "done" ? "Re-clean requested" : "Request a re-clean"}
            </DialogTitle>
          </DialogHeader>
          {state === "done" ? (
            <p className="text-sm">
              Thanks. {businessName} has been told and will be back within the guarantee.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                For your visit on {visitDay}. There&apos;s no charge for a re-clean.
              </p>
              <div>
                <Label htmlFor="reclean-message" className="text-xs">
                  What should we look at? (optional)
                </Label>
                <Textarea
                  id="reclean-message"
                  value={msg}
                  onChange={(e) => setMsg(e.target.value)}
                  rows={3}
                  maxLength={1000}
                  placeholder="The corner behind the shed, the side yard…"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            {state === "done" ? (
              <Button className="min-h-11" onClick={() => close(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button variant="ghost" className="min-h-11" onClick={() => close(false)}>
                  Cancel
                </Button>
                <Button
                  className="min-h-11"
                  disabled={state === "sending"}
                  onClick={async () => {
                    setState("sending");
                    try {
                      await onSubmit(msg);
                      setState("done");
                    } catch {
                      // The mutation's onError has already said why.
                      setState("idle");
                    }
                  }}
                >
                  {state === "sending" ? "Sending…" : "Request a re-clean"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The general "Report a concern" for a business that runs no pet waste
 *  (#560): no missed spot, no wrong yard. */
const GENERAL_CONCERN_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "other", label: "Other" },
  { value: "gate_left_open", label: "A door, gate or key was left unsecured" },
  { value: "damage", label: "Damage to my home or property" },
];

export function ReportGeneralConcern({
  onSubmit,
  pending,
  petWaste = true,
}: {
  onSubmit: (cat: string, msg: string) => void;
  pending: boolean;
  /** Whether the business runs pet waste; fails open to the yard list. */
  petWaste?: boolean;
}) {
  const options = petWaste ? CONCERN_OPTIONS : GENERAL_CONCERN_OPTIONS;
  const [cat, setCat] = useState("other");
  const [msg, setMsg] = useState("");
  return (
    <div className="rounded-md border bg-card p-3 text-sm space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,200px)_1fr]">
        <div>
          <Label className="text-xs">Category</Label>
          <Select value={cat} onValueChange={setCat}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">What's going on?</Label>
          <Textarea
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            rows={2}
            placeholder={
              petWaste
                ? "Missing spot, billing question, anything at all"
                : "A visit, a billing question, anything at all"
            }
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          We typically respond within one business day.
        </p>
        <Button
          size="sm"
          disabled={pending || !msg.trim()}
          onClick={() => {
            onSubmit(cat, msg);
            setMsg("");
          }}
        >
          {pending ? "Sending…" : "Send to the office"}
        </Button>
      </div>
    </div>
  );
}

export function RequestsList({ rows }: { rows: Array<any> }) {
  if (rows.length === 0) {
    return (
      <EmptyBox
        icon={<MessageCircleWarning className="h-6 w-6 shrink-0" />}
        title="Nothing here yet"
        body="Concerns and requests you send will show up here with their status."
      />
    );
  }
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const s = friendlyStatus(r.status);
        // An extra cleanup is answered by being booked or not, and "Resolved"
        // says neither. Booked wins over the status, since it is the fact the
        // customer is waiting for.
        // A groom request, and a training lesson asked for from a package, are
        // answered the same way: booked or not.
        const oneOff =
          r.category === "one_off_request" ||
          r.category === "groom_request" ||
          r.category === "training_lesson_request";
        const oneOffState = oneOff ? oneOffRequestState(r) : null;
        const badge = oneOffState === "booked" ? (
          <Badge className="bg-emerald-600 hover:bg-emerald-600">Booked</Badge>
        ) : oneOffState === "declined" ? (
          <Badge variant="secondary">Not booked</Badge>
        ) :
          s === "Resolved" ? (
            <Badge className="bg-emerald-600 hover:bg-emerald-600">Resolved</Badge>
          ) : s === "In review" ? (
            <Badge className="bg-amber-500 hover:bg-amber-500">In review</Badge>
          ) : (
            <Badge variant="secondary">Received</Badge>
          );
        return (
          <li key={r.ticket_id} className="rounded-md border bg-card p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium">
                  {/* A request for one of the business's services reads as
                      that service ("30-minute walk"); the extra cleanup, and
                      every other kind of request, as its category. */}
                  {oneOff && r.service_name ? r.service_name : friendlyCategory(r.category)}
                  {r.visit_date && (
                    <span className="text-muted-foreground">
                      {" "}
                      · visit {fmtDayShort(r.visit_date)}
                    </span>
                  )}
                  {oneOff && r.requested_on && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {r.booked_on ? `booked for ${fmtDayShort(r.booked_on)}` : `for ${fmtDayShort(r.requested_on)}`}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  Sent {fmtDayShort(r.created_at)}
                </div>
              </div>
              {badge}
            </div>
            {r.message && <p className="mt-2 text-sm">{r.message}</p>}
            {r.resolution_note && (
              <div className="mt-2 rounded border-l-2 border-emerald-500 bg-emerald-50 p-2 text-xs text-emerald-900">
                <strong>Office reply:</strong> {r.resolution_note}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ReferralCard({
  code,
  orgName,
  isCommercial,
}: {
  code: string;
  orgName: string;
  isCommercial: boolean;
}) {
  const shareText = isCommercial
    ? `We use ${orgName} at our property and recommend them. Use code ${code} and we both get credit.`
    : `I use ${orgName} and think you'd like them too. Use code ${code} and we both save on your first month.`;
  const [copied, setCopied] = useState(false);
  const share = async () => {
    if (typeof navigator !== "undefined" && (navigator as any).share) {
      try {
        await (navigator as any).share({ title: orgName, text: shareText });
        return;
      } catch {
        /* fall through */
      }
    }
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="rounded-lg border bg-gradient-to-br from-primary/10 to-primary/5 p-4 text-sm">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {isCommercial ? "Your property referral code" : "Your neighbor code"}
      </div>
      <div className="mt-1 font-mono text-2xl font-semibold tracking-wider">{code}</div>
      <p className="mt-2 text-muted-foreground">
        {isCommercial
          ? "Share with another property manager or board. When they sign up, both properties get a credit."
          : "Share your code with a neighbor. When they sign up, you both get credit."}
      </p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={share} className="gap-1.5">
          <Share2 className="h-4 w-4 shrink-0" /> {copied ? "Copied!" : "Share"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            navigator.clipboard?.writeText(code);
            toast.success("Code copied");
          }}
        >
          Copy code
        </Button>
      </div>
    </div>
  );
}
