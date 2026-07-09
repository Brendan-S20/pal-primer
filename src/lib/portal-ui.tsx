/* Shared UI, hooks, and helpers for the client portal.
 * All sibling routes under /portal/$token/* pull data from usePortal(token).
 * React Query caches by key so switching tabs is instant. */

import { createContext, useContext, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Camera, CheckCircle2, Clock, CloudRain, MapPin, MessageCircleWarning,
  PalmtreeIcon, Share2, X, Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

import { useNavigate } from "@tanstack/react-router";
import {
  portalContext,
  portalRequestOtp,
  portalVerifyOtp,
  portalOrgBySlug,
  portalIdentify,
  portalVerifyGenericOtp,
  portalChooseAccount,
  portalGetClient,
  portalListUpcomingVisits,
  portalListInvoices,
  portalListPrepaidSubs,
  portalRequestSkip,
  portalStartPrepaidTopup,
  portalCreateCheckout,
  portalRescheduleVisit,
  portalChangeFrequency,
  portalListAddonCatalog,
  portalListClientAddons,
  portalSubscribeAddon,
  portalCancelAddon,
  portalStartCardSetup,
  portalSetAutopay,
  portalRemoveCard,
  portalPayInvoiceWithSavedCard,
  portalListRecentVisits,
  portalListDogs,
  portalReportConcern,
  portalSignPhotoUrls,
  portalGetReferral,
  portalListStations,
  portalListMyRequests,
  portalRequestVacationHold,
  portalRedeemPromo,
} from "@/lib/portal.functions";

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
  const d = toDate(s); if (!d) return "";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export function fmtDayShort(s: string | null | undefined) {
  const d = toDate(s); if (!d) return "";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function fmtTime(s: string | null | undefined) {
  const d = toDate(s); if (!d) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function relativeFromToday(s: string | null | undefined): string {
  const d = toDate(s); if (!d) return "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1 && days <= 14) return `in ${days} days`;
  if (days < -1 && days >= -14) return `${-days} days ago`;
  return "";
}

export function friendlyFrequency(f: string | null | undefined) {
  if (!f) return "";
  return { weekly: "Weekly", biweekly: "Every 2 weeks", twice_weekly: "Twice weekly", monthly: "Monthly" }[f] ?? f;
}

export function friendlyCategory(c: string | null | undefined) {
  const map: Record<string, string> = {
    missed_spot: "Missed spot", gate_left_open: "Gate left open",
    damage: "Damage", wrong_yard: "Wrong yard", other: "Other",
  };
  return map[c ?? ""] ?? (c ?? "");
}

export function friendlyStatus(s: string) {
  const map: Record<string, string> = {
    open: "Received", received: "Received",
    in_review: "In review", pending: "In review",
    resolved: "Resolved", closed: "Resolved",
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
  const topupFn = useServerFn(portalStartPrepaidTopup);
  const checkoutFn = useServerFn(portalCreateCheckout);
  const rescheduleFn = useServerFn(portalRescheduleVisit);
  const changeFreqFn = useServerFn(portalChangeFrequency);
  const listAddonCatalogFn = useServerFn(portalListAddonCatalog);
  const listClientAddonsFn = useServerFn(portalListClientAddons);
  const subscribeAddonFn = useServerFn(portalSubscribeAddon);
  const cancelAddonFn = useServerFn(portalCancelAddon);
  const startSetupFn = useServerFn(portalStartCardSetup);
  const setAutopayFn = useServerFn(portalSetAutopay);
  const removeCardFn = useServerFn(portalRemoveCard);
  const payWithSavedFn = useServerFn(portalPayInvoiceWithSavedCard);
  const historyFn = useServerFn(portalListRecentVisits);
  const dogsFn = useServerFn(portalListDogs);
  const referralFn = useServerFn(portalGetReferral);
  const concernFn = useServerFn(portalReportConcern);
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
    queryFn: () => contextFn({ data: { token } }),
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
    onError: (e) => toast.error((e as Error).message),
  });
  const verifyOtpMut = useMutation({
    mutationFn: (code: string) => verifyOtpFn({ data: { token, code } }),
    onSuccess: async () => {
      await contextQ.refetch();
      invalidatePortal();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const concernMut = useMutation({
    mutationFn: (v: { visitId: string | null; category: any; message: string }) =>
      concernFn({ data: { token, ...v } }),
    onSuccess: () => { toast.success("Thanks — we'll follow up shortly."); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const skipMut = useMutation({
    mutationFn: (v: { visitId: string; reason: string }) => skipFn({ data: { token, ...v } }),
    onSuccess: () => { toast.success("Skip requested"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const topupMut = useMutation({
    mutationFn: (v: { subscriptionId: string; visitCount: number }) => topupFn({ data: { token, ...v } }),
    onSuccess: async (r) => {
      const { url } = await checkoutFn({ data: { token, invoiceId: r.invoiceId, returnUrl: window.location.href } });
      window.location.href = url;
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const payMut = useMutation({
    mutationFn: (invoiceId: string) => checkoutFn({ data: { token, invoiceId, returnUrl: window.location.href } }),
    onSuccess: (r) => { window.location.href = r.url; },
    onError: (e) => toast.error((e as Error).message),
  });
  const rescheduleMut = useMutation({
    mutationFn: (v: { visitId: string; newDate: string }) => rescheduleFn({ data: { token, ...v } }),
    onSuccess: () => { toast.success("Visit rescheduled"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const freqMut = useMutation({
    mutationFn: (v: { subscriptionId: string; frequency: "weekly"|"biweekly"|"twice_weekly"|"monthly" }) =>
      changeFreqFn({ data: { token, ...v } }),
    onSuccess: () => { toast.success("Plan change submitted"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const subscribeAddonMut = useMutation({
    mutationFn: (v: { addonServiceId: string; frequency: "weekly"|"biweekly"|"monthly"|"quarterly"|"yearly"|null; quantity: number }) =>
      subscribeAddonFn({ data: { token, ...v } }),
    onSuccess: () => { toast.success("Added to your next visit"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const cancelAddonMut = useMutation({
    mutationFn: (addonSubscriptionId: string) => cancelAddonFn({ data: { token, addonSubscriptionId } }),
    onSuccess: () => { toast.success("Add-on canceled"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const startSetupMut = useMutation({
    mutationFn: () => startSetupFn({ data: { token, returnUrl: window.location.href } }),
    onSuccess: (r) => { window.location.href = r.url; },
    onError: (e) => toast.error((e as Error).message),
  });
  const setAutopayMut = useMutation({
    mutationFn: (enabled: boolean) => setAutopayFn({ data: { token, enabled } }),
    onSuccess: (r) => { toast.success(r.enabled ? "Autopay on" : "Autopay off"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const removeCardMut = useMutation({
    mutationFn: () => removeCardFn({ data: { token } }),
    onSuccess: () => { toast.success("Card removed"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const paySavedMut = useMutation({
    mutationFn: (invoiceId: string) => payWithSavedFn({ data: { token, invoiceId } }),
    onSuccess: () => { toast.success("Payment submitted"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const vacationMut = useMutation({
    mutationFn: (v: { startDate: string; endDate: string; reason: string }) =>
      vacationFn({ data: { token, ...v } }),
    onSuccess: (r) => {
      toast.success(r.skippedCount > 0
        ? `${r.skippedCount} visit${r.skippedCount === 1 ? "" : "s"} skipped for your vacation`
        : "Vacation hold sent to the office for review");
      invalidatePortal();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const promoMut = useMutation({
    mutationFn: (code: string) => promoFn({ data: { token, code } }),
    onSuccess: (r) => { toast.success(`${money(r.creditCents)} credit added to your account`); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });

  return {
    token, slug: slug ?? "", signPhotosFn,
    contextQ, verified, requestOtpMut, verifyOtpMut,
    clientQ, visitsQ, invoicesQ, subsQ, catalogQ, clientAddonsQ,
    historyQ, dogsQ, referralQ, stationsQ, requestsQ,
    concernMut, skipMut, topupMut, payMut, rescheduleMut, freqMut,
    subscribeAddonMut, cancelAddonMut, startSetupMut, setAutopayMut,
    removeCardMut, paySavedMut, vacationMut, promoMut,
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
function PortalBrandedShell({ branding, children }: { branding: Branding; children: React.ReactNode }) {
  const brand = branding && isHex(branding.brandColor) ? (branding.brandColor as string) : "#16a34a";
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <div className="mb-5 flex flex-col items-center text-center">
        {branding?.logoUrl ? (
          <img src={branding.logoUrl} alt={branding.orgName}
            className="h-14 w-14 rounded-xl object-contain" style={{ background: `${brand}14` }} />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded-xl text-xl font-bold text-white"
            style={{ background: brand }}>
            {(branding?.orgName ?? "•").slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="mt-2 text-lg font-semibold">{branding?.orgName ?? "Client portal"}</div>
      </div>
      <div className="rounded-2xl border bg-card p-6 shadow-sm" style={{ borderTopColor: brand, borderTopWidth: 3 }}>
        {children}
      </div>
      <p className="mt-4 text-center text-xs text-muted-foreground">
        Trouble getting the code? Call or text us and we can read it to you.
      </p>
    </div>
  );
}

/** The 6-digit code input + verify/resend/back controls, shared by both flows. */
function CodeEntry({
  sentHint, pending, onVerify, onResend, onBack, resending,
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
        {sentHint ? `We sent a 6-digit code to ${sentHint}. Enter it below.` : "Enter the 6-digit code we gave you."}
      </p>
      <Input
        inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456"
        value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        className="text-center text-lg tracking-[0.3em]"
      />
      <Button className="w-full" disabled={pending || code.length < 6} onClick={() => onVerify(code)}>
        {pending ? "Verifying…" : "Verify"}
      </Button>
      <div className="flex justify-between text-xs text-muted-foreground">
        {onBack ? (
          <button className="hover:underline" onClick={onBack}>← Back</button>
        ) : <span />}
        {onResend ? (
          <button className="hover:underline disabled:opacity-50" disabled={resending} onClick={onResend}>
            Resend code
          </button>
        ) : <span />}
      </div>
    </div>
  );
}

/** Channel picker ("text me" / "email me") + the "already have a code" path. */
function ChannelChooser({
  channels, channel, setChannel, onSend, sending, onHaveCode,
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
        <button key={c.channel} onClick={() => setChannel(c.channel)}
          className={`flex w-full items-center justify-between rounded-lg border p-3 text-left text-sm ${
            channel === c.channel ? "border-primary ring-1 ring-primary" : ""
          }`}>
          <span>{c.channel === "sms" ? "Text me a code" : "Email me a code"}</span>
          <span className="text-muted-foreground">{c.hint}</span>
        </button>
      ))}
      <Button className="w-full" disabled={sending} onClick={onSend}>
        {sending ? "Sending…" : "Send code"}
      </Button>
      <button className="w-full text-center text-xs text-muted-foreground hover:underline" onClick={onHaveCode}>
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
    if (channels.length && !channels.some((c) => c.channel === channel)) setChannel(channels[0].channel);
  }, [channels, channel]);

  return (
    <PortalBrandedShell branding={branding}>
      <h1 className="text-xl font-semibold">Verify it's you</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        For your security, we'll send a one-time code to the contact on file before showing your account.
      </p>
      <div className="mt-5">
        {channels.length === 0 ? (
          <div className="space-y-3">
            <p className="rounded-md bg-muted p-3 text-sm">
              We don't have a phone or email on file to text or email you a code. Call or text us and
              we can read you a code to enter here.
            </p>
            <CodeEntry pending={verifyOtpMut.isPending} onVerify={(c) => verifyOtpMut.mutate(c)} />
          </div>
        ) : step === "choose" ? (
          <ChannelChooser
            channels={channels} channel={channel} setChannel={setChannel}
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

  const [contact, setContact] = useState("");
  const [step, setStep] = useState<"identify" | "code" | "pick">("identify");
  const [candidates, setCandidates] = useState<Array<{ id: string; label: string }>>([]);

  const orgQ = useQuery({
    queryKey: ["portal-org", slug],
    queryFn: () => orgFn({ data: { slug } }),
    retry: false,
  });
  const org = orgQ.data as any;
  const branding: Branding = org?.found ? org.branding : null;

  const goToPortal = (s: string, token: string) =>
    navigate({ to: "/portal/$slug/$token", params: { slug: s || slug, token } });

  const identifyMut = useMutation({
    mutationFn: () => identifyFn({ data: { slug, contact } }),
    onSuccess: () => setStep("code"),
    onError: (e) => toast.error((e as Error).message),
  });
  const verifyMut = useMutation({
    mutationFn: (code: string) => verifyFn({ data: { slug, contact, code } }),
    onSuccess: (r: any) => {
      if (r.status === "verified") goToPortal(r.slug, r.token);
      else { setCandidates(r.candidates); setStep("pick"); }
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const chooseMut = useMutation({
    mutationFn: (clientId: string) => chooseFn({ data: { clientId } }),
    onSuccess: (r: any) => goToPortal(r.slug, r.token),
    onError: (e) => toast.error((e as Error).message),
  });

  if (orgQ.isLoading) {
    return <div className="mx-auto max-w-md p-8 text-center text-sm text-muted-foreground">Loading…</div>;
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
            Enter the phone number or email on your account and we'll send you a one-time code.
          </p>
          <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); if (contact.trim()) identifyMut.mutate(); }}>
            <Input
              type="text" inputMode="email" autoComplete="email" placeholder="you@example.com or (555) 123-4567"
              value={contact} onChange={(e) => setContact(e.target.value)}
            />
            <Button type="submit" className="w-full" disabled={identifyMut.isPending || !contact.trim()}>
              {identifyMut.isPending ? "Sending…" : "Send code"}
            </Button>
          </form>
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
              <button key={c.id} disabled={chooseMut.isPending}
                onClick={() => chooseMut.mutate(c.id)}
                className="flex w-full items-center justify-between rounded-lg border p-3 text-left text-sm hover:border-primary disabled:opacity-50">
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

export function PortalProvider({ token, slug, children }: { token: string; slug?: string; children: React.ReactNode }) {
  const portal = usePortal(token, slug);
  return <PortalContext.Provider value={portal}>{children}</PortalContext.Provider>;
}

export function usePortalCtx(): PortalCtx {
  const v = useContext(PortalContext);
  if (!v) throw new Error("usePortalCtx must be used inside <PortalProvider>");
  return v;
}

/* ────────────────────────── reusable UI ───────────────────────── */

export function EmptyBox({ icon, title, body }: { icon?: React.ReactNode; title: string; body?: string }) {
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
  return <Badge variant="secondary">Open</Badge>;
}

export function UpcomingVisitsList({ rows, cutoffHours, allowReschedule, onSkip, onReschedule }: {
  rows: Array<any>;
  cutoffHours: number;
  allowReschedule: boolean;
  onSkip: (id: string, reason: string) => void;
  onReschedule: (id: string, newDate: string) => void;
}) {
  const addresses = new Set(rows.map((r) => `${r.street}|${r.city}|${r.postal_code}`));
  const sharedAddress = addresses.size === 1 && rows[0]?.street ? rows[0] : null;
  return (
    <>
      {sharedAddress && (
        <p className="mb-2 text-xs text-muted-foreground inline-flex items-center gap-1">
          <MapPin className="h-3 w-3" />
          {[sharedAddress.street, sharedAddress.city, sharedAddress.postal_code].filter(Boolean).join(", ")}
        </p>
      )}
      <ul className="divide-y rounded-md border bg-card">
        {rows.map((v) => (
          <VisitRow key={v.visit_id} v={v}
            showAddress={!sharedAddress}
            cutoffHours={cutoffHours}
            allowReschedule={allowReschedule}
            onSkip={(reason) => onSkip(v.visit_id, reason)}
            onReschedule={(d) => onReschedule(v.visit_id, d)} />
        ))}
      </ul>
    </>
  );
}

function VisitRow({ v, showAddress, cutoffHours, allowReschedule, onSkip, onReschedule }: {
  v: any;
  showAddress: boolean;
  cutoffHours: number;
  allowReschedule: boolean;
  onSkip: (reason: string) => void;
  onReschedule: (newDate: string) => void;
}) {
  const [skipOpen, setSkipOpen] = useState(false);
  const [reschedOpen, setReschedOpen] = useState(false);
  const [reason, setReason] = useState("");
  const minDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const maxDate = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const [newDate, setNewDate] = useState(minDate);

  const scheduled = toDate(v.scheduled_on);
  const cutoff = scheduled ? new Date(scheduled.getTime() - cutoffHours * 3600 * 1000) : null;
  const pastCutoff = cutoff ? Date.now() > cutoff.getTime() : false;

  const cutoffCopy = `Changes allowed until ${cutoff ? cutoff.toLocaleDateString(undefined, { weekday: "long" }) + " at " + cutoff.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "24h before"}.`;

  return (
    <li className="p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">{fmtDay(v.scheduled_on)}</div>
          <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-2">
            {v.eta_start && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" /> arriving {fmtTime(v.eta_start)}–{fmtTime(v.eta_end)}
              </span>
            )}
            {relativeFromToday(v.scheduled_on) && <span>· {relativeFromToday(v.scheduled_on)}</span>}
            {v.tech_name && <span>· with <strong>{v.tech_name}</strong></span>}
            {showAddress && (v.street || v.city) && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" /> {[v.street, v.city].filter(Boolean).join(", ")}
              </span>
            )}
          </div>
          {v.weather_flagged && (
            <div className="mt-1 inline-flex items-center gap-1 rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-800">
              <CloudRain className="h-3 w-3" /> {v.weather_note ?? "Weather may affect this visit"}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {allowReschedule && !pastCutoff && (
            <Button size="sm" variant="outline" onClick={() => { setReschedOpen((o) => !o); setSkipOpen(false); }}>
              {reschedOpen ? "Cancel" : "Reschedule"}
            </Button>
          )}
          <Button size="sm" variant="outline"
            disabled={pastCutoff}
            title={pastCutoff ? "Past the change cutoff — text the office" : undefined}
            onClick={() => { setSkipOpen((o) => !o); setReschedOpen(false); }}>
            {skipOpen ? "Cancel" : "Skip"}
          </Button>
        </div>
      </div>

      {(skipOpen || reschedOpen) && (
        <p className="mt-2 text-xs text-muted-foreground">{cutoffCopy} A skipped visit may still be billable per your agreement.</p>
      )}

      {reschedOpen && !pastCutoff && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor={`d-${v.visit_id}`} className="text-xs">New date</Label>
            <Input id={`d-${v.visit_id}`} type="date" min={minDate} max={maxDate}
              value={newDate} onChange={(e) => setNewDate(e.target.value)} className="w-40" />
          </div>
          <Button size="sm" onClick={() => { onReschedule(newDate); setReschedOpen(false); }}>
            Confirm reschedule to {fmtDayShort(newDate)}
          </Button>
        </div>
      )}
      {skipOpen && !pastCutoff && (
        <div className="mt-3 space-y-2">
          <Label htmlFor={`r-${v.visit_id}`} className="text-xs">Reason (optional)</Label>
          <Input id={`r-${v.visit_id}`} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Out of town, etc." />
          <Button size="sm" onClick={() => { onSkip(reason); setSkipOpen(false); setReason(""); }}>
            Confirm skip {fmtDayShort(v.scheduled_on)}
          </Button>
        </div>
      )}
    </li>
  );
}

export function PlanRow({ s, isCommercial, allowChange, autoApply, onChange, pending }: {
  s: { subscription_id: string; frequency: string; property_label: string | null; price_cents: number };
  isCommercial: boolean;
  allowChange: boolean;
  autoApply: boolean;
  onChange: (f: "weekly"|"biweekly"|"twice_weekly"|"monthly") => void;
  pending: boolean;
}) {
  const [freq, setFreq] = useState<string>(s.frequency);
  return (
    <li className="rounded-md border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <div className="font-medium">{s.property_label ?? (isCommercial ? "Service contract" : "Weekly service")}</div>
          <div className="text-xs text-muted-foreground">
            Currently {friendlyFrequency(s.frequency)} · {money(s.price_cents)}/visit
          </div>
        </div>
        {allowChange && (
          <>
            <div>
              <Label className="text-xs">Change frequency</Label>
              <Select value={freq} onValueChange={setFreq}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                  <SelectItem value="twice_weekly">Twice weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" disabled={pending || freq === s.frequency}
              onClick={() => onChange(freq as any)}>
              {autoApply ? "Update plan" : "Request change"}
            </Button>
          </>
        )}
      </div>
      {allowChange && !autoApply && (
        <p className="mt-2 text-xs text-muted-foreground">
          Frequency changes are reviewed by the office before they take effect. We'll confirm within one business day.
        </p>
      )}
    </li>
  );
}

export function VacationHoldCard({ autoApply, onSubmit, pending }: {
  autoApply: boolean;
  onSubmit: (v: { startDate: string; endDate: string; reason: string }) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const min = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const [start, setStart] = useState(min);
  const [end, setEnd] = useState(min);
  const [reason, setReason] = useState("");
  return (
    <div className="rounded-md border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PalmtreeIcon className="h-4 w-4 text-muted-foreground" />
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
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Beach week" />
          </div>
          <div className="sm:col-span-3 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {autoApply
                ? "Visits in this range will be skipped immediately."
                : "The office will confirm and skip the affected visits within one business day."}
            </p>
            <Button size="sm" disabled={pending}
              onClick={() => onSubmit({ startDate: start, endDate: end, reason })}>
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
            <Badge variant="outline" className="mt-2 text-[10px] capitalize">{d.temperament}</Badge>
          )}
          {d.notes && <p className="mt-2 text-xs text-muted-foreground">{d.notes}</p>}
        </li>
      ))}
    </ul>
  );
}

export function StationsPanel({ rows }: { rows: Array<any> }) {
  if (rows.length === 0)
    return <EmptyBox icon={<Trash2 className="h-6 w-6" />} title="No stations set up yet"
      body="Once we install stations at your property they'll be listed here." />;
  return (
    <ul className="divide-y rounded-md border bg-card">
      {rows.map((s) => (
        <li key={s.station_id} className="p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-medium">{s.label}</div>
              {s.location_description && (
                <div className="text-xs text-muted-foreground">{s.location_description}</div>
              )}
            </div>
            <div className="text-xs text-muted-foreground text-right">
              {s.capacity_liners && <div>Capacity: {s.capacity_liners} liners</div>}
              <div>Last serviced: {s.last_serviced_on ? fmtDayShort(s.last_serviced_on) : "—"}</div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function AddonCard({ a, onSubscribe, pending }: {
  a: any;
  onSubscribe: (freq: "weekly"|"biweekly"|"monthly"|"quarterly"|"yearly"|null, qty: number) => void;
  pending: boolean;
}) {
  const [qty, setQty] = useState(1);
  const [freq, setFreq] = useState<string>(a.default_frequency ?? "monthly");
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
          <div>
            <Label className="text-xs">Qty</Label>
            <Input type="number" min={1} max={50} value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} className="w-20" />
          </div>
          {isRecurring && (
            <div>
              <Label className="text-xs">Frequency</Label>
              <Select value={freq} onValueChange={setFreq}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
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
          <Button size="sm" disabled={pending}
            onClick={() => onSubscribe(isRecurring ? (freq as any) : null, qty)}>
            {isRecurring ? "Subscribe" : "Add"}
          </Button>
        </div>
      </div>
    </li>
  );
}

export function TopupRow({ s, onSubmit, pending }: {
  s: { subscription_id: string; price_cents: number; frequency: string; property_label: string | null };
  onSubmit: (count: number) => void;
  pending: boolean;
}) {
  const [count, setCount] = useState(4);
  return (
    <li className="flex flex-wrap items-end gap-3 rounded-md border bg-card p-3 text-sm">
      <div className="flex-1">
        <div className="font-medium">{s.property_label ?? "Service"} · {friendlyFrequency(s.frequency)}</div>
        <div className="text-xs text-muted-foreground">{money(s.price_cents)} per visit</div>
      </div>
      <div>
        <Label htmlFor={`n-${s.subscription_id}`} className="text-xs">Visits</Label>
        <Input id={`n-${s.subscription_id}`} type="number" min={1} max={52} value={count}
          onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} className="w-24" />
      </div>
      <div className="text-sm font-medium">= {money(count * s.price_cents)}</div>
      <Button size="sm" disabled={pending} onClick={() => onSubmit(count)}>Pay & top up</Button>
    </li>
  );
}

export function PromoRedeemCard({ onSubmit, pending }: { onSubmit: (code: string) => void; pending: boolean }) {
  const [code, setCode] = useState("");
  return (
    <div className="rounded-md border bg-card p-3 text-sm">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">Promo or gift code</p>
      <div className="mt-2 flex gap-2">
        <Input value={code} onChange={(e) => setCode(e.target.value)}
          placeholder="Enter code" className="uppercase" />
        <Button size="sm" disabled={pending || !code.trim()}
          onClick={() => { onSubmit(code.trim()); setCode(""); }}>
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
  rows, signPhotos, token, onReport, reporting,
}: {
  rows: Array<any>;
  signPhotos: (args: { data: { token: string; paths: string[] } }) => Promise<{ urls: Record<string, string> }>;
  token: string;
  onReport: (visitId: string, category: string, message: string) => void;
  reporting: boolean;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    const paths = rows.flatMap((r) => r.photo_paths ?? []);
    if (paths.length === 0) return;
    let cancelled = false;
    signPhotos({ data: { token, paths } }).then((r) => {
      if (!cancelled) setUrls(r.urls);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [rows, signPhotos, token]);

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
        <Camera className="h-4 w-4" /> Service history
      </h2>
      {rows.length === 0 ? (
        <EmptyBox icon={<Camera className="h-6 w-6" />}
          title="No completed visits yet"
          body="After your first visit, we'll post before/after photos here." />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.visit_id} className="rounded-md border bg-card p-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{fmtDay(r.scheduled_on)}</div>
                  <div className="text-xs text-muted-foreground flex flex-wrap gap-2">
                    {r.status === "completed" ? (
                      <>
                        <span className="inline-flex items-center gap-1 text-emerald-700">
                          <CheckCircle2 className="h-3 w-3" /> Completed
                          {r.completed_at && <> at {fmtTime(r.completed_at)}</>}
                        </span>
                        {r.tech_name && <span>· by <strong>{r.tech_name}</strong></span>}
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-700">
                        <X className="h-3 w-3" /> Skipped
                        {r.skip_reason && <> — {r.skip_reason}</>}
                      </span>
                    )}
                  </div>
                </div>
                {r.status === "completed" && (
                  <ConcernButton onSubmit={(cat, msg) => onReport(r.visit_id, cat, msg)} pending={reporting} />
                )}
              </div>

              {r.status === "completed" && (r.photo_paths?.length ?? 0) === 0 && (
                <p className="mt-2 text-xs text-muted-foreground italic">
                  Photos not available for this visit.
                </p>
              )}

              {(r.photo_paths?.length ?? 0) > 0 && (
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {r.photo_paths.map((p: string, i: number) => (
                    <button key={p} onClick={() => urls[p] && setLightbox(urls[p])}
                      className="group relative aspect-square overflow-hidden rounded border bg-muted">
                      {urls[p] ? (
                        <>
                          <img src={urls[p]} alt="Visit photo" loading="lazy"
                            className="h-full w-full object-cover transition group-hover:scale-105" />
                          <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium uppercase text-white">
                            {i % 2 === 0 ? "Before" : "After"}
                          </span>
                        </>
                      ) : (
                        <div className="h-full w-full animate-pulse bg-muted" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {lightbox && (
        <div onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <img src={lightbox} alt="Visit photo" className="max-h-full max-w-full rounded" />
        </div>
      )}
    </section>
  );
}

const CONCERN_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "missed_spot", label: "Missed spot" },
  { value: "gate_left_open", label: "Gate left open" },
  { value: "damage", label: "Damage to yard/property" },
  { value: "wrong_yard", label: "Wrong yard serviced" },
  { value: "other", label: "Other" },
];

function ConcernButton({ onSubmit, pending }: { onSubmit: (cat: string, msg: string) => void; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState("missed_spot");
  const [msg, setMsg] = useState("");
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Report</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Report a concern</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">What happened?</Label>
              <Select value={cat} onValueChange={setCat}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CONCERN_OPTIONS.map((o) => (<SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Details (optional)</Label>
              <Textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={3}
                placeholder="Tell us what to look for or fix" />
            </div>
            <p className="text-xs text-muted-foreground">We usually respond within one business day.</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={pending} onClick={() => { onSubmit(cat, msg); setOpen(false); setMsg(""); }}>
              {pending ? "Sending…" : "Send to the office"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ReportGeneralConcern({ onSubmit, pending }: { onSubmit: (cat: string, msg: string) => void; pending: boolean }) {
  const [cat, setCat] = useState("other");
  const [msg, setMsg] = useState("");
  return (
    <div className="rounded-md border bg-card p-3 text-sm space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,200px)_1fr]">
        <div>
          <Label className="text-xs">Category</Label>
          <Select value={cat} onValueChange={setCat}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {CONCERN_OPTIONS.map((o) => (<SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">What's going on?</Label>
          <Textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={2}
            placeholder="Missing spot, billing question, anything at all" />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">We typically respond within one business day.</p>
        <Button size="sm" disabled={pending || !msg.trim()} onClick={() => { onSubmit(cat, msg); setMsg(""); }}>
          {pending ? "Sending…" : "Send to the office"}
        </Button>
      </div>
    </div>
  );
}

export function RequestsList({ rows }: { rows: Array<any> }) {
  if (rows.length === 0) {
    return <EmptyBox icon={<MessageCircleWarning className="h-6 w-6" />} title="Nothing here yet"
      body="Concerns and requests you send will show up here with their status." />;
  }
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const s = friendlyStatus(r.status);
        const badge = s === "Resolved"
          ? <Badge className="bg-emerald-600 hover:bg-emerald-600">Resolved</Badge>
          : s === "In review"
            ? <Badge className="bg-amber-500 hover:bg-amber-500">In review</Badge>
            : <Badge variant="secondary">Received</Badge>;
        return (
          <li key={r.ticket_id} className="rounded-md border bg-card p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium">
                  {friendlyCategory(r.category)}
                  {r.visit_date && <span className="text-muted-foreground"> · visit {fmtDayShort(r.visit_date)}</span>}
                </div>
                <div className="text-xs text-muted-foreground">Sent {fmtDayShort(r.created_at)}</div>
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

export function ReferralCard({ code, orgName, isCommercial }: { code: string; orgName: string; isCommercial: boolean }) {
  const shareText = isCommercial
    ? `We use ${orgName} at our property for pet waste service — use code ${code} and we both get credit.`
    : `I use ${orgName} for pet waste removal — use code ${code} and we both save on your first month.`;
  const [copied, setCopied] = useState(false);
  const share = async () => {
    if (typeof navigator !== "undefined" && (navigator as any).share) {
      try { await (navigator as any).share({ title: orgName, text: shareText }); return; } catch { /* fall through */ }
    }
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
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
          <Share2 className="h-4 w-4" /> {copied ? "Copied!" : "Share"}
        </Button>
        <Button size="sm" variant="outline"
          onClick={() => { navigator.clipboard?.writeText(code); toast.success("Code copied"); }}>
          Copy code
        </Button>
      </div>
    </div>
  );
}
