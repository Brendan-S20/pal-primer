import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  getMyDay,
  startVisit,
  completeVisit,
  skipVisit,
  recordVisitPhoto,
} from "@/lib/my-day.functions";
import { listAddonServices, createAddonCharge } from "@/lib/addons.functions";
import { sendVisitStatusSms } from "@/lib/messages.functions";
import { SKIP_REASON_CODES, SKIP_REASON_LABELS } from "@/lib/skip-rules.functions";
import { useOnline, usePendingCount } from "@/lib/offline/useOnline";
import { useOfflineVisitActions } from "@/lib/offline/useOfflineVisitActions";
import { syncQueue } from "@/lib/offline/sync";
import { countPendingForVisit } from "@/lib/offline/queue";
import { toast } from "sonner";
import { Navigation, Camera, ChevronDown, ChevronUp, WifiOff, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/_authenticated/my-day")({
  component: MyDay,
});

function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60_000);
  return local.toISOString().slice(0, 10);
}

function MyDay() {
  const [day, setDay] = useState(todayISO());
  const fn = useServerFn(getMyDay);
  const qc = useQueryClient();
  const online = useOnline();
  const pending = usePendingCount();

  const { data, isLoading } = useQuery({
    queryKey: ["my-day", day],
    queryFn: () => fn({ data: { day } }),
  });

  // Bind server-fn callers once for the sync driver.
  const startFn = useServerFn(startVisit);
  const completeFn = useServerFn(completeVisit);
  const skipFn = useServerFn(skipVisit);
  const photoFn = useServerFn(recordVisitPhoto);
  const callers = useMemo(
    () => ({
      startVisit: startFn,
      completeVisit: completeFn,
      skipVisit: skipFn,
      recordVisitPhoto: photoFn,
    }),
    [startFn, completeFn, skipFn, photoFn],
  );

  const runSync = useCallback(async () => {
    const res = await syncQueue(callers);
    if (res.succeeded > 0) {
      toast.success(`Synced ${res.succeeded} queued action${res.succeeded === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["my-day"] });
    }
    if (res.failed > 0) {
      toast.error(`Sync stalled on 1 action — will retry`);
    }
  }, [callers, qc]);

  // Auto-sync on load + whenever we come back online.
  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.onLine) runSync();
    const on = () => runSync();
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [runSync]);

  const visits = data?.visits ?? [];
  const staff = data?.staff;

  const done = visits.filter((v: any) => v.status === "completed" || v.status === "skipped").length;
  const total = visits.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const nextUp = visits.find((v: any) => v.status === "scheduled" || v.status === "in_progress");

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-4">
      {(!online || pending > 0) && (
        <div
          className={`flex items-center justify-between gap-3 rounded-lg border p-3 text-sm ${
            online
              ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
              : "border-destructive/50 bg-destructive/10 text-destructive"
          }`}
        >
          <div className="flex items-center gap-2">
            {!online && <WifiOff className="h-4 w-4" />}
            <span className="font-medium">
              {!online ? "You're offline" : "Back online"}
              {pending > 0 ? ` · ${pending} pending action${pending === 1 ? "" : "s"}` : ""}
            </span>
          </div>
          {online && pending > 0 && (
            <button
              onClick={runSync}
              className="inline-flex items-center gap-1 rounded border border-current px-2 py-1 text-xs font-medium hover:bg-background/50"
            >
              <RefreshCw className="h-3 w-3" /> Sync now
            </button>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">My day</h1>
          <p className="text-sm text-muted-foreground">
            {staff ? `${staff.display_name} · ${staff.role}` : "Not on any staff record"}
          </p>
        </div>
        <input
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          className="rounded-md border bg-background px-3 py-2 text-sm"
        />
      </div>

      {total > 0 && (
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between text-sm">
            <div className="font-medium">
              {done} of {total} done
            </div>
            <div className="text-muted-foreground">{pct}%</div>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          {nextUp && (
            <div className="mt-3 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                Next: <span className="font-medium text-foreground">{nextUp.clients?.display_name}</span>
              </span>
              <a
                href={`#visit-${nextUp.id}`}
                className="text-primary underline"
              >
                Jump →
              </a>
            </div>
          )}
        </div>
      )}

      {!staff && (
        <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          Your user is not linked to a staff record yet. Ask an owner to add you.
        </div>
      )}

      {staff && visits.length === 0 && (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          Nothing scheduled for you on this day.
        </div>
      )}

      <ol className="space-y-3">
        {visits.map((v: any, idx: number) => (
          <VisitCard key={v.id} visit={v} index={idx + 1} day={day} />
        ))}
      </ol>
    </div>
  );
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    scheduled: "bg-muted text-muted-foreground",
    in_progress: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    skipped: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    canceled: "bg-destructive/15 text-destructive",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${map[status] ?? "bg-muted"}`}>
      {status.replace("_", " ")}
    </span>
  );
}

type HazardKey =
  | "do_not_enter_if_dog_out"
  | "aggressive_dog"
  | "escape_risk"
  | "invisible_fence"
  | "bees_wasps"
  | "sharp_objects"
  | "slippery_surfaces"
  | "dog_in_yard_during_service";

const HAZARD_LABELS: Record<HazardKey, { label: string; severity: "critical" | "warn" }> = {
  do_not_enter_if_dog_out: { label: "DO NOT ENTER if dog is outside", severity: "critical" },
  aggressive_dog: { label: "Aggressive dog", severity: "critical" },
  escape_risk: { label: "Escape risk — close gate immediately", severity: "critical" },
  invisible_fence: { label: "Invisible fence", severity: "warn" },
  dog_in_yard_during_service: { label: "Dog in yard during service", severity: "warn" },
  bees_wasps: { label: "Bees / wasps", severity: "warn" },
  sharp_objects: { label: "Sharp objects", severity: "warn" },
  slippery_surfaces: { label: "Slippery surfaces", severity: "warn" },
};

function HazardBanner({ property }: { property: any }) {
  if (!property) return null;
  const active = (Object.keys(HAZARD_LABELS) as HazardKey[]).filter((k) => property[k]);
  const notes = property.hazard_notes as string | undefined;
  if (active.length === 0 && !notes) return null;
  const critical = active.filter((k) => HAZARD_LABELS[k].severity === "critical");
  const warn = active.filter((k) => HAZARD_LABELS[k].severity === "warn");
  return (
    <div className="mb-3 space-y-2">
      {critical.length > 0 && (
        <div className="rounded-md border-2 border-destructive bg-destructive/10 p-3">
          <div className="text-xs font-bold uppercase tracking-wide text-destructive">
            ⚠ Safety warnings — read before entering
          </div>
          <ul className="mt-1 space-y-0.5 text-sm font-semibold text-destructive">
            {critical.map((k) => (
              <li key={k}>• {HAZARD_LABELS[k].label}</li>
            ))}
          </ul>
        </div>
      )}
      {warn.length > 0 && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            {warn.map((k) => (
              <span key={k}>⚠ {HAZARD_LABELS[k].label}</span>
            ))}
          </div>
        </div>
      )}
      {notes && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-800 dark:text-amber-300">
          <span className="font-semibold">Hazard notes:</span> {notes}
        </div>
      )}
    </div>
  );
}

function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return (
    <span className="font-mono tabular-nums">
      {m}:{s.toString().padStart(2, "0")}
    </span>
  );
}

function PhotoThumb({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    supabase.storage
      .from("visit-photos")
      .createSignedUrl(path, 300)
      .then(({ data }) => {
        if (!cancelled && data) setUrl(data.signedUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (!url) return <div className="h-14 w-14 animate-pulse rounded bg-muted" />;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="Visit" className="h-14 w-14 rounded border object-cover" />
    </a>
  );
}

function mapsUrl(p: any): string {
  const q = encodeURIComponent(
    [p?.street, p?.city, p?.postal_code].filter(Boolean).join(", "),
  );
  return `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}

function VisitCard({ visit, index, day }: { visit: any; index: number; day: string }) {
  const qc = useQueryClient();
  const smsFn = useServerFn(sendVisitStatusSms);

  const actions = useOfflineVisitActions(visit.id, visit.organization_id as string | undefined);

  const [showSkip, setShowSkip] = useState(false);
  const [showAddon, setShowAddon] = useState(false);
  const [addonSvcId, setAddonSvcId] = useState("");
  const [addonQty, setAddonQty] = useState("1");
  const addonListFn = useServerFn(listAddonServices);
  const addonChargeFn = useServerFn(createAddonCharge);
  const { data: addonSvcData } = useQuery({
    queryKey: ["addon-services"],
    queryFn: () => addonListFn({ data: {} }),
    staleTime: 5 * 60_000,
  });
  const addonServices: any[] = addonSvcData?.services ?? [];
  const addonMut = useMutation({
    mutationFn: () =>
      addonChargeFn({
        data: {
          clientId: visit.client_id,
          addonServiceId: addonSvcId,
          quantity: Math.max(1, parseInt(addonQty, 10) || 1),
          visitId: visit.id,
          source: "field",
        },
      }),
    onSuccess: () => {
      toast.success("Add-on billed");
      setShowAddon(false);
      setAddonSvcId("");
      setAddonQty("1");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const [reason, setReason] = useState("");
  const [reasonCode, setReasonCode] = useState<(typeof SKIP_REASON_CODES)[number]>("other");
  const [uploading, setUploading] = useState(false);
  const [photoKind, setPhotoKind] = useState<"before" | "completion" | "issue">("completion");
  const [pendingLocal, setPendingLocal] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  // Refresh per-visit pending count so cards can show a subtle "queued" chip.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      countPendingForVisit(visit.id).then((c) => !cancelled && setPendingLocal(c));
    };
    refresh();
    window.addEventListener("offline-queue-change", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("offline-queue-change", refresh);
    };
  }, [visit.id]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["my-day", day] });

  const start = useMutation({
    mutationFn: () => actions.start(),
    onSuccess: (r) => {
      toast.success(r.queued ? "Queued — starts when back online" : "Started");
      if (!r.queued) invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const complete = useMutation({
    mutationFn: () => actions.complete(),
    onSuccess: (r) => {
      toast.success(r.queued ? "Queued — completes when back online" : "Completed");
      if (!r.queued) invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const skip = useMutation({
    mutationFn: () => actions.skip(reason, reasonCode),
    onSuccess: (r) => {
      toast.success(r.queued ? "Queued — will skip when back online" : "Marked skipped");
      setShowSkip(false);
      if (!r.queued) invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const sms = useMutation({
    mutationFn: (kind: "reminder" | "on_my_way" | "completed") =>
      smsFn({ data: { visitId: visit.id, kind } }),
    onSuccess: () => toast.success("SMS sent"),
    onError: (e: Error) => toast.error(e.message),
  });

  const uploadPhoto = async (file: File) => {
    setUploading(true);
    try {
      const r = await actions.uploadPhoto(file, photoKind);
      toast.success(
        r.queued
          ? `${photoKind[0].toUpperCase() + photoKind.slice(1)} photo queued — uploads when online`
          : `${photoKind[0].toUpperCase() + photoKind.slice(1)} photo uploaded`,
      );
      if (!r.queued) invalidate();
    } catch (e: any) {
      toast.error(e.message ?? "Upload failed");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const photos = useMemo(() => visit.visit_photos ?? [], [visit.visit_photos]);
  const hasCompletionPhoto = photos.some((p: any) => p.kind === "completion");
  // If a completion photo is queued locally, allow "Complete" — the sync
  // driver replays photos first (older ts) then complete (newer ts).
  const hasQueuedCompletionPhoto = pendingLocal > 0;
  const done = visit.status === "completed";
  const skipped = visit.status === "skipped";
  const inProg = visit.status === "in_progress";
  const scheduled = visit.status === "scheduled";
  const finalStatus = done || skipped;
  const p = visit.properties;
  const [collapsed, setCollapsed] = useState(finalStatus);
  useEffect(() => { setCollapsed(finalStatus); }, [finalStatus]);

  return (
    <li id={`visit-${visit.id}`} className={`rounded-lg border bg-card p-4 shadow-sm ${inProg ? "ring-2 ring-blue-500/40" : ""}`}>
      {!collapsed && <HazardBanner property={p} />}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">#{visit.sequence ?? index}</span>
            {visit.zones?.name && <span>· {visit.zones.name}</span>}
            {statusBadge(visit.status)}
            {pendingLocal > 0 && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                {pendingLocal} queued
              </span>
            )}
            {inProg && visit.started_at && (
              <span className="text-blue-600 dark:text-blue-400">
                · <ElapsedTimer startedAt={visit.started_at} />
              </span>
            )}
          </div>
          <div className="mt-1 truncate text-base font-semibold">
            {visit.clients?.display_name ?? "Client"}
          </div>
          <div className="text-sm text-muted-foreground">
            {p?.street}{p?.city ? `, ${p.city}` : ""}{p?.postal_code ? ` ${p.postal_code}` : ""}
          </div>

          {!collapsed && (
            <>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                {p?.gate_code && (
                  <div><span className="text-muted-foreground">Gate:</span> <span className="font-mono">{p.gate_code}</span></div>
                )}
                {p?.lock_box_code && (
                  <div><span className="text-muted-foreground">Lock box:</span> <span className="font-mono">{p.lock_box_code}</span></div>
                )}
                {p?.key_location && (
                  <div className="col-span-2"><span className="text-muted-foreground">Key:</span> {p.key_location}</div>
                )}
                {p?.yard_size && (
                  <div><span className="text-muted-foreground">Yard:</span> {p.yard_size}</div>
                )}
              </div>
              {p?.parking_notes && (<div className="mt-1 text-xs text-muted-foreground">🅿 {p.parking_notes}</div>)}
              {p?.access_notes && (<div className="mt-1 text-xs text-muted-foreground">{p.access_notes}</div>)}
              {skipped && (
                <div className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  Skipped
                  {visit.skip_reason_code
                    ? ` (${SKIP_REASON_LABELS[visit.skip_reason_code as keyof typeof SKIP_REASON_LABELS] ?? visit.skip_reason_code})`
                    : ""}
                  {visit.skip_reason ? `: ${visit.skip_reason}` : ""}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex flex-col items-end gap-1.5">
          {p?.street && (
            <a
              href={mapsUrl(p)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-10 items-center gap-1 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-accent active:bg-accent"
            >
              <Navigation className="h-4 w-4" /> Navigate
            </a>
          )}
          {visit.clients?.primary_phone && (
            <a
              href={`tel:${visit.clients.primary_phone}`}
              className="inline-flex min-h-10 items-center rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-accent active:bg-accent"
            >
              📞 Call
            </a>
          )}
          {finalStatus && (
            <button
              onClick={() => setCollapsed((c) => !c)}
              className="grid h-10 w-10 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={collapsed ? "Expand" : "Collapse"}
            >
              {collapsed ? <ChevronDown className="h-5 w-5" /> : <ChevronUp className="h-5 w-5" />}
            </button>
          )}
        </div>
      </div>

      {!collapsed && photos.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {photos.map((ph: any) => (
            <div key={ph.id} className="relative">
              <PhotoThumb path={ph.storage_path} />
              <span className="absolute -bottom-1 -right-1 rounded bg-background px-1 text-[9px] uppercase text-muted-foreground shadow-sm">
                {ph.kind}
              </span>
            </div>
          ))}
        </div>
      )}

      {!finalStatus && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadPhoto(f);
              }}
            />
            <select
              value={photoKind}
              onChange={(e) => setPhotoKind(e.target.value as any)}
              className="h-10 rounded-md border bg-background px-3 text-sm"
              aria-label="Photo type"
            >
              <option value="before">Before</option>
              <option value="completion">Completion</option>
              <option value="issue">Issue</option>
            </select>
            <Button
              type="button"
              variant="outline"
              size="default"
              className="h-10"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              <Camera className="mr-1.5 h-4 w-4" />
              {uploading ? "Uploading…" : "Take photo"}
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            {scheduled && (
              <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
                Start
              </Button>
            )}
            <Button
              size="sm"
              variant="default"
              disabled={(!hasCompletionPhoto && !hasQueuedCompletionPhoto) || complete.isPending || (!inProg && !scheduled)}
              onClick={() => complete.mutate()}
              title={hasCompletionPhoto || hasQueuedCompletionPhoto ? "" : "Add a completion photo first"}
            >
              Complete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowSkip((s) => !s)}>
              Skip
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowAddon((s) => !s)}>
              + Add-on
            </Button>
            {visit.clients?.primary_phone && (
              <>
                <Button size="sm" variant="outline" disabled={sms.isPending} onClick={() => sms.mutate("reminder")}>
                  Text reminder
                </Button>
                <Button size="sm" variant="outline" disabled={sms.isPending} onClick={() => sms.mutate("on_my_way")}>
                  Text "on my way"
                </Button>
              </>
            )}
          </div>

          {showSkip && (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Reason</label>
                <select
                  value={reasonCode}
                  onChange={(e) => setReasonCode(e.target.value as any)}
                  className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  {SKIP_REASON_CODES.map((c) => (
                    <option key={c} value={c}>{SKIP_REASON_LABELS[c]}</option>
                  ))}
                </select>
              </div>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Details (what happened, photos, etc.)"
                rows={2}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!reason.trim() || skip.isPending}
                  onClick={() => skip.mutate()}
                >
                  Confirm skip
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowSkip(false)}>
                  Cancel
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Billing rules for each reason are set in Settings → Skip rules.
              </p>
            </div>
          )}

          {showAddon && (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              <div className="text-xs font-medium text-muted-foreground">Bill an add-on to this client</div>
              <div className="grid grid-cols-6 gap-2">
                <select
                  className="col-span-4 h-9 rounded-md border bg-background px-2 text-sm"
                  value={addonSvcId}
                  onChange={(e) => setAddonSvcId(e.target.value)}
                >
                  <option value="">Select service…</option>
                  {addonServices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — ${(s.unit_price_cents / 100).toFixed(2)}
                    </option>
                  ))}
                </select>
                <input
                  type="number" min="1"
                  className="col-span-1 h-9 rounded-md border bg-background px-2 text-sm"
                  value={addonQty}
                  onChange={(e) => setAddonQty(e.target.value)}
                />
                <Button size="sm" className="col-span-1"
                  disabled={!addonSvcId || addonMut.isPending}
                  onClick={() => addonMut.mutate()}>
                  Bill
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Prepaid clients are debited immediately; postpaid clients see it on the next invoice.
              </p>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
