import i18n from "@/lib/i18n";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { holdForUndo, UNDO_WINDOW_MS, type HeldChange } from "@/lib/undo-window";
import { skipReasonText } from "@/lib/skip-reason-text";
import { useSignedUrl } from "@/hooks/useSignedUrl";
import { useOrgTimezone, useOrgToday } from "@/hooks/useOrgToday";
import { orgLocalTime } from "@/lib/org-day";
import { formatDistance } from "@/lib/measures";
import { useDistanceUnit } from "@/hooks/useDistanceUnit";
import { supabase } from "@/integrations/supabase/client";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  getVisitDetail,
  completeVisitFromOffice,
  cancelVisitFromOffice,
  deleteVisitPhotoFromOffice,
  markVisitMissedFromOffice,
  reopenVisitFromOffice,
  reassignVisit,
  rescheduleVisitFromOffice,
  listStaff,
} from "@/lib/visits.functions";
import { formatDay } from "@/lib/format";
import { usePermissions } from "@/hooks/useMyRole";
import { addDog, setDogDna } from "@/lib/dogs.functions";
import { useOfflineVisitActions } from "@/lib/offline/useOfflineVisitActions";
import { Input } from "@/components/ui/input";
import {
  Navigation,
  CheckCircle2,
  SkipForward,
  Phone,
  Mail,
  AlertTriangle,
  Loader2,
  ExternalLink,
  Camera,
  PawPrint,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { PHOTO_KIND_OPTIONS, photoKindLabel, defaultPhotoKind, type PhotoKind } from "@/lib/photo-kinds";
import { parseAnswers } from "@/lib/visit-checklist";
import { VisitChecklistAnswers } from "@/components/VisitChecklistAnswers";
import { visitStayDates } from "@/lib/stays";
import {
  TrainingProgressPanel,
  TrainingSessionBadge,
} from "@/components/training/TrainingProgressPanel";
import { LessonSessionUse } from "@/components/training/LessonSessionUse";
import { warnLessonClashes } from "@/components/training/lessonClashWarning";
import {
  ClientCalledAtField,
  clientCalledAtIso,
  nowAsCalledAt,
} from "@/components/training/ClientCalledAtField";
import { BUSINESS_REASONS } from "@/lib/training-packages";

const MISSED_REASON_LABELS: Record<(typeof BUSINESS_REASONS)[number], string> = {
  our_fault: "Our fault",
  weather: "Weather",
  unsafe_conditions: "Unsafe conditions",
};

function fmtAddress(p: any): string {
  if (!p) return "";
  return [p.street, p.city, p.region, p.postal_code].filter(Boolean).join(", ");
}

function directionsUrl(p: any): string | null {
  if (!p) return null;
  const dest =
    p.latitude != null && p.longitude != null
      ? `${p.latitude},${p.longitude}`
      : encodeURIComponent([p.street, p.city, p.postal_code].filter(Boolean).join(", "));
  if (!dest) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
}

function hazardList(p: any): string[] {
  if (!p) return [];
  const flags: [boolean, string][] = [
    [p.aggressive_dog, "Aggressive dog"],
    [p.dog_in_yard_during_service, "Dog in yard"],
    [p.escape_risk, "Escape risk"],
    [p.invisible_fence, "Invisible fence"],
    [p.bees_wasps, "Bees / wasps"],
    [p.sharp_objects, "Sharp objects"],
    [p.slippery_surfaces, "Slippery surfaces"],
    [p.do_not_enter_if_dog_out, "Do NOT enter if dog is out"],
  ];
  return flags.filter(([v]) => v).map(([, l]) => l);
}

function PhotoThumb({ path }: { path: string }) {
  const { url } = useSignedUrl("visit-photos", path);
  if (!url) return <div className="h-16 w-16 animate-pulse rounded bg-muted" />;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img
        src={url}
        alt="Visit"
        width={64}
        height={64}
        loading="lazy"
        decoding="async"
        className="h-16 w-16 rounded border object-cover"
      />
    </a>
  );
}

export function VisitDetailDrawer({
  visitId,
  onOpenChange,
}: {
  visitId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = !!visitId;
  const tz = useOrgTimezone();
  const distanceUnit = useDistanceUnit();
  const qc = useQueryClient();
  const getDetail = useServerFn(getVisitDetail);
  // This drawer opens from /routes and /dashboard, and ROUTE_ROLES excludes
  // techs from both — so nobody who can see these buttons is ever the visit's
  // assigned tech. It used to call the TECH RPCs (start_visit / complete_visit
  // / skip_visit), every one of which authorizes on is_visit_tech(). Confirmed
  // against the live database on a real scheduled visit: the org's own OWNER
  // returns false for that guard and true for can_write_org. So all three
  // buttons were guaranteed to fail with "Not authorized for this visit",
  // for every user who could reach them.
  //
  // The desktop board already had this right (routes.tsx uses
  // completeVisitFromOffice and says why); the drawer never got the same
  // treatment. It now uses the office_* variants, which authorize on
  // can_write_org.
  const doComplete = useServerFn(completeVisitFromOffice);
  const doCancel = useServerFn(cancelVisitFromOffice);
  const doReopen = useServerFn(reopenVisitFromOffice);
  const doMarkMissed = useServerFn(markVisitMissedFromOffice);
  // Cosmetic gate only — requirePermission("manage_client_billing") inside the
  // office server functions is the real one. Showing a dispatcher a button
  // that throws is the failure this whole change is about, so hide it.
  const { can, role } = usePermissions();
  const canActFromOffice = can("manage_client_billing");

  // Q-12, narrowest useful answer. Below 768px the dnd board is display:none
  // and there is no other way to move a visit, so a dispatcher on a phone
  // could not do the one thing a phone is for: a tech calls in sick and the
  // day has to be redistributed from wherever they are standing.
  //
  // Reassign for every office role: reassign_visit authorizes on
  // can_write_org, which all three pass. Moving the day is here too since
  // 2026-09-28, for the roles that hold manage_client_billing (which
  // rescheduleVisitFromOffice requires, so a dispatcher still does not see
  // it). Before that it said "is on desktop", and an owner in a driveway with
  // a customer asking for Thursday had no way to do it. Reorder stays on the
  // board; it has no meaning without one.
  const doReassign = useServerFn(reassignVisit);
  const listStaffFn = useServerFn(listStaff);
  const { data: staffData } = useQuery({
    enabled: !!visitId,
    queryKey: ["staff"],
    queryFn: () => listStaffFn(),
    staleTime: 5 * 60_000,
  });
  const doReschedule = useServerFn(rescheduleVisitFromOffice);
  const orgToday = useOrgToday();
  const [moveTo, setMoveTo] = useState("");
  useEffect(() => setMoveTo(""), [visitId]);
  const rescheduleMut = useMutation({
    mutationFn: () => doReschedule({ data: { visitId: visitId!, newDate: moveTo } }),
    onSuccess: (r) => {
      const who = r.techName ?? "The tech";
      if (r.tech === "kept") {
        toast.success(`Visit moved to ${formatDay(moveTo)}`, {
          description: `${who} keeps it.`,
        });
      } else if (r.tech === "dropped") {
        toast.warning(`Visit moved to ${formatDay(moveTo)}, unassigned`, {
          description: `${who} is not working that day, so dispatch or auto-routing places it.`,
          duration: 9000,
        });
      } else {
        toast.success(`Visit moved to ${formatDay(moveTo)}`);
      }
      if (r.clash) toast.warning(r.clash);
      warnLessonClashes(r);
      if (r.clash) toast.warning(r.clash);
      setMoveTo("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  // Reassigning used to apply the moment the native select changed, with no
  // undo, and reassignVisit tells the tech losing the stop and the tech
  // gaining it before it returns (QA row 16). On a phone a mis-tap in a
  // native picker is easy. So the change is HELD for a few seconds behind an
  // Undo toast and only then sent: nothing is written and nobody is told
  // until the window closes. `pendingStaff` is what the select shows while
  // it waits (undefined: nothing held).
  const [pendingStaff, setPendingStaff] = useState<string | null | undefined>(undefined);
  const held = useRef<{ change: HeldChange; toastId: string | number } | null>(null);
  useEffect(() => setPendingStaff(undefined), [visitId]);
  const reassignTo = (staffId: string | null, name: string | null) => {
    const vid = visitId!;
    // A second pick inside the window replaces the first: the latest choice
    // is the one meant, and the first was never sent.
    if (held.current && held.current.change.undo()) toast.dismiss(held.current.toastId);
    // Picking the tech it already has is the same as Undo.
    if (staffId === (v?.assigned_staff_id ?? null)) {
      setPendingStaff(undefined);
      return;
    }
    setPendingStaff(staffId);
    // The overnight clash warning is shown once the change is sent, since
    // nothing is checked while it is held.
    const send = () =>
      doReassign({ data: { visitId: vid, staffId } }).then((r) => {
        if (r.clash) toast.warning(r.clash);
        warnLessonClashes(r);
        if (r.clash) toast.warning(r.clash);
        return r;
      });
    const change = holdForUndo(send, {
      onError: (e) => toast.error(e instanceof Error ? e.message : "Could not reassign the visit"),
    });
    const toastId = toast(name ? `Reassigned to ${name}` : "Visit unassigned", {
      description: "The techs are told when this closes.",
      duration: UNDO_WINDOW_MS,
      action: {
        label: "Undo",
        onClick: () => {
          if (change.undo()) setPendingStaff(undefined);
        },
      },
    });
    held.current = { change, toastId };
    void change.done.then(async (sent) => {
      if (held.current?.change === change) held.current = null;
      if (sent) {
        // The board and the mobile day list both key off "visits"; the tech
        // lanes are grouped client-side from the same query.
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["visit-detail", vid] }),
          qc.invalidateQueries({ queryKey: ["visits"] }),
        ]);
      }
      setPendingStaff((p) => (p === staffId ? undefined : p));
    });
  };

  const { data, isLoading } = useQuery({
    enabled: !!visitId,
    queryKey: ["visit-detail", visitId],
    queryFn: () => getDetail({ data: { visitId: visitId! } }),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["visit-detail", visitId] });
    qc.invalidateQueries({ queryKey: ["visits"] });
  };

  const completeMut = useMutation({
    mutationFn: () => doComplete({ data: { visitId: visitId! } }),
    onSuccess: () => {
      toast.success("Visit completed");
      invalidate();
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const [skipReason, setSkipReason] = useState("");
  // On a training package lesson: when the client called to cancel.
  const [calledAt, setCalledAt] = useState("");
  useEffect(() => setCalledAt(nowAsCalledAt()), [visitId]);
  const cancelMut = useMutation({
    // The office variant requires a reason — no silent "Skipped from dispatch"
    // default, because that string was being written to real visits as if a
    // human had given it.
    mutationFn: () =>
      doCancel({
        data: {
          visitId: visitId!,
          reason: skipReason,
          code: "other",
          clientCancelledAt: data?.visit?.client_package_id ? clientCalledAtIso(calledAt) : null,
        },
      }),
    onSuccess: () => {
      toast.success("Visit canceled");
      invalidate();
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reopenMut = useMutation({
    mutationFn: () => doReopen({ data: { visitId: visitId! } }),
    onSuccess: () => {
      toast.success("Visit reopened");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  // On a training package lesson, why it was missed. The business's own
  // reasons use no session.
  const [missedCode, setMissedCode] = useState<"" | (typeof BUSINESS_REASONS)[number]>("");
  useEffect(() => setMissedCode(""), [visitId]);
  const markMissedMut = useMutation({
    mutationFn: () => doMarkMissed({ data: { visitId: visitId!, code: missedCode || null } }),
    onSuccess: () => {
      toast.success("Visit marked missed");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const v: any = data?.visit;
  const p = v?.properties;
  const client = v?.clients;
  const dogs = data?.dogs ?? [];
  const recent = data?.recent ?? [];
  const upcoming = data?.upcoming ?? [];
  const hazards = hazardList(p);
  const dir = directionsUrl(p);
  // There is no office_start_visit — starting a visit stamps a tech's arrival,
  // and the office has no honest value to stamp. The Start button here never
  // worked; it is gone rather than reimplemented as a lie.
  const canComplete = v?.status === "scheduled" || v?.status === "in_progress";
  // office_skip_visit is narrower than the tech path on purpose: a visit
  // already in progress has a tech on site, and cancelling it from a desk
  // would overwrite what they are doing.
  const canCancel = v?.status === "scheduled";
  const canReviewCompleted = v?.status === "completed";
  // Only work that has not happened yet can be moved. Reassigning a completed
  // visit would rewrite who did it.
  const canReassign = v?.status === "scheduled";
  const techs = (staffData?.staff ?? []).filter(
    (s: any) => s.is_field_tech || s.id === v?.assigned_staff_id,
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Safe area, top and bottom. Measured on an iPhone 17 Pro 2026-08-25:
          Close occupied y 8-52 and the title y 24-52 against a 54pt status
          bar, so the clock printed through the client name and the battery
          glyph sat on the X. This is the screen a tech opens at every stop.
          This drawer carried its own copy of the insets and the close
          button's offset; since 2026-10-04 ui/sheet.tsx gives both to every
          full-height sheet, after the owner's iPhone found the same fault on
          the client editors that had no copy. */}
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {client?.display_name ?? "Visit"}
            {v?.status && (
              <Badge variant="secondary" className="capitalize">
                {i18n.t(`status.${v.status}`, { defaultValue: "Visit" })}
              </Badge>
            )}
            {/* Booked by text, through the AI receptionist (subscriptions.booked_via). */}
            {(v as any)?.subscriptions?.booked_via === "ai_receptionist" && (
              <Badge variant="outline">Booked by AI receptionist</Badge>
            )}
            {/* Part of a sitter's stay (#411): the stay's dates. */}
            {visitStayDates((v as any)?.subscriptions?.stays) && (
              <Badge variant="outline">Stay, {visitStayDates((v as any).subscriptions.stays)}</Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            {formatDay(v?.scheduled_on)}
            {/* What this visit is (services, phase 2): the business's own
                name for it, so it keeps its own direction. */}
            {v?.services?.name ? (
              <>
                {" · "}
                <bdi className="font-medium text-foreground">{v.services.name}</bdi>
              </>
            ) : null}{" "}
            {v?.zones?.name ? `· ${v.zones.name}` : ""}
            {v?.staff?.display_name ? ` · ${v.staff.display_name}` : ""}
          </SheetDescription>
        </SheetHeader>

        {v?.id && <TrainingSessionBadge visitId={v.id} serviceLine={v.services?.service_line} />}

        {isLoading || !v ? (
          <div className="flex justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin shrink-0" />
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {hazards.length > 0 && (
              <div className="rounded-md border-2 border-destructive/50 bg-destructive/10 p-3 text-sm">
                <div className="flex items-center gap-2 font-semibold text-destructive">
                  <AlertTriangle className="h-4 w-4 shrink-0" /> Safety notes
                </div>
                <ul className="mt-1 list-disc pl-6 text-destructive">
                  {hazards.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
                {p?.hazard_notes && (
                  <p className="mt-2 text-xs text-destructive/90">{p.hazard_notes}</p>
                )}
              </div>
            )}

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">Address</h3>
              <p className="text-sm">{fmtAddress(p)}</p>
              <div className="flex flex-wrap gap-2">
                {dir && (
                  <a href={dir} target="_blank" rel="noreferrer">
                    <Button size="sm" variant="outline">
                      <Navigation className="mr-1.5 h-3.5 w-3.5 shrink-0" />
                      Directions
                    </Button>
                  </a>
                )}
                {client?.primary_phone && (
                  <a href={`tel:${client.primary_phone}`}>
                    <Button size="sm" variant="outline">
                      <Phone className="mr-1.5 h-3.5 w-3.5 shrink-0" />
                      Call
                    </Button>
                  </a>
                )}
                {client?.primary_email && (
                  <a href={`mailto:${client.primary_email}`}>
                    <Button size="sm" variant="outline">
                      <Mail className="mr-1.5 h-3.5 w-3.5 shrink-0" />
                      Email
                    </Button>
                  </a>
                )}
                <Link
                  to="/clients/$clientId"
                  params={{ clientId: v.client_id }}
                  onClick={() => onOpenChange(false)}
                >
                  <Button size="sm" variant="ghost">
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5 shrink-0" />
                    Open client
                  </Button>
                </Link>
                {p?.id && (
                  <Link
                    to="/properties/$propertyId/boundary"
                    params={{ propertyId: p.id }}
                    onClick={() => onOpenChange(false)}
                  >
                    <Button size="sm" variant="ghost">
                      Boundary map
                    </Button>
                  </Link>
                )}
              </div>
              {(p?.gate_code || p?.lock_box_code || p?.key_location) && (
                <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-2 text-xs">
                  {p.gate_code && (
                    <div>
                      <span className="text-muted-foreground">Gate:</span>{" "}
                      <span className="font-mono">{p.gate_code}</span>
                    </div>
                  )}
                  {p.lock_box_code && (
                    <div>
                      <span className="text-muted-foreground">Lock box:</span>{" "}
                      <span className="font-mono">{p.lock_box_code}</span>
                    </div>
                  )}
                  {p.key_location && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Key:</span> {p.key_location}
                    </div>
                  )}
                </div>
              )}
              {(p?.parking_notes || p?.access_notes) && (
                <div className="rounded-md border p-2 text-xs">
                  {p.parking_notes && (
                    <div>
                      <span className="text-muted-foreground">Parking:</span> {p.parking_notes}
                    </div>
                  )}
                  {p.access_notes && (
                    <div>
                      <span className="text-muted-foreground">Access:</span> {p.access_notes}
                    </div>
                  )}
                </div>
              )}
            </section>

            <DogsSection
              propertyId={p?.id}
              dogs={dogs}
              onChanged={() => qc.invalidateQueries({ queryKey: ["visit-detail", visitId] })}
            />

            {v?.id && (
              <TrainingProgressPanel visitId={v.id} serviceLine={v.services?.service_line} />
            )}
            {v?.id && <LessonSessionUse visit={v} />}

            {(v.eta_start || v.travel_min != null) && (
              <section className="rounded-md border p-2 text-xs">
                {v.eta_start && <div>ETA {orgLocalTime(v.eta_start, tz)}</div>}
                {v.travel_km != null && (
                  <div>
                    Drive {formatDistance(v.travel_km, distanceUnit)} ·{" "}
                    {Math.round(Number(v.travel_min ?? 0))} min
                  </div>
                )}
                {v.window_violated && (
                  <Badge variant="destructive" className="mt-1">
                    Outside window
                  </Badge>
                )}
              </section>
            )}

            {(v.skip_reason ||
              v.status === "skipped" ||
              v.weather_note ||
              v.tech_note ||
              v.completion_photo_waived_reason) && (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                  Notes
                </h3>
                {v.tech_note && (
                  <p className="whitespace-pre-wrap text-sm">
                    <span className="text-muted-foreground">From the tech:</span> {v.tech_note}
                  </p>
                )}
                {v.completion_photo_waived_reason && (
                  <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
                    No completion photo: {v.completion_photo_waived_reason}
                  </p>
                )}
                {v.weather_note && <p className="whitespace-pre-wrap text-sm">{v.weather_note}</p>}
                {/* A skipped visit always says why, or says that nobody
                    recorded why. A bare "Skipped" badge on a future stop read
                    as a fault in the schedule (QA row 15). */}
                {(v.skip_reason || v.status === "skipped") && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    Skip: {skipReasonText(v.skip_reason, v.skip_reason_code)}
                  </p>
                )}
              </section>
            )}

            {/* What the tech confirmed, with the labels as they read the day
                the visit was completed. Absent when nothing asked. */}
            <VisitChecklistAnswers answers={parseAnswers(v.visit_checklist) ?? []} />

            <PhotosSection key={visitId!} visitId={visitId!} photos={v.visit_photos ?? []} status={v.status} />

            {/* Past and future apart. One "Other visits here" list, newest
                first, put next month's scheduled visits above last week's
                completed one — see getVisitDetail for why it was mostly the
                future. */}
            <OtherVisits title="Recent visits" visits={recent} />
            <OtherVisits title="Coming up" visits={upcoming} />

            {canReassign && (
              <section className="space-y-1 border-t pt-3">
                <Label htmlFor="reassign" className="text-xs">
                  Assigned tech
                </Label>
                {/* 36px on a pointer, 44px on touch: the same floor the
                    Timesheets person picker uses. */}
                <select
                  id="reassign"
                  className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm touch:min-h-11"
                  value={(pendingStaff === undefined ? v?.assigned_staff_id : pendingStaff) ?? ""}
                  onChange={(e) => {
                    const id = e.target.value || null;
                    const name = id
                      ? String(techs.find((s: any) => s.id === id)?.display_name ?? "another tech")
                      : null;
                    reassignTo(id, name);
                  }}
                >
                  <option value="">Unassigned</option>
                  {techs.map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {s.display_name}
                      {s.routing_available ? "" : " (off routes)"}
                    </option>
                  ))}
                </select>
                {canActFromOffice && (
                  <form
                    className="space-y-1 pt-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (moveTo) rescheduleMut.mutate();
                    }}
                  >
                    <Label htmlFor="visit-move-to" className="text-xs">
                      Move to another day
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id="visit-move-to"
                        type="date"
                        className="min-w-0 flex-1"
                        min={orgToday}
                        value={moveTo}
                        onChange={(e) => setMoveTo(e.target.value)}
                      />
                      <Button
                        type="submit"
                        variant="outline"
                        className="shrink-0"
                        disabled={!moveTo || moveTo === v?.scheduled_on || rescheduleMut.isPending}
                      >
                        {rescheduleMut.isPending ? "Moving…" : "Move"}
                      </Button>
                    </div>
                    <p className="text-2xs text-muted-foreground">
                      It stays with the same tech when the new day is a work day and they are
                      not off. Otherwise it is left unassigned for dispatch. Reordering a
                      tech's stops is on the Schedule board.
                    </p>
                  </form>
                )}
              </section>
            )}

            {(canComplete || canCancel) && (
              <section className="space-y-2 border-t pt-3">
                {!canActFromOffice ? (
                  // A dispatcher reaches this drawer but holds neither
                  // manage_client_billing nor the tech guard, so there is no
                  // path by which either action succeeds. Say that, rather
                  // than render buttons that throw.
                  <p className="text-xs text-muted-foreground">
                    {role === "dispatcher"
                      ? "Completing or canceling a visit is an office action. The assigned tech closes it out, or an owner or office manager does it from the client's Visits tab."
                      : "You don't have permission to close out a visit."}
                  </p>
                ) : (
                  <>
                    {canComplete && (
                      <div className="flex flex-wrap gap-2">
                        {/* `size="sm"` is a 25px box. This is the field
                            tech's primary action — the one thing they press
                            in a driveway — and it was the smallest control in
                            the drawer on every touch device. */}
                        <Button
                          size="sm"
                          onClick={() => completeMut.mutate()}
                          disabled={completeMut.isPending}
                          className="touch:min-h-11"
                        >
                          <CheckCircle2 className="mr-1.5 h-4 w-4 shrink-0" />
                          Complete
                        </Button>
                      </div>
                    )}
                    {canCancel && (
                      <div className="space-y-1">
                        <Label htmlFor="skip" className="text-xs">
                          Cancellation reason
                        </Label>
                        <Textarea
                          id="skip"
                          rows={2}
                          value={skipReason}
                          onChange={(e) => setSkipReason(e.target.value)}
                          placeholder="Gate locked, dog outside, weather…"
                        />
                        {v.client_package_id && (
                          <ClientCalledAtField
                            id="skip-called-at"
                            value={calledAt}
                            onChange={setCalledAt}
                          />
                        )}
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => cancelMut.mutate()}
                          disabled={cancelMut.isPending || !skipReason.trim()}
                        >
                          <SkipForward className="mr-1.5 h-4 w-4 shrink-0" />
                          Cancel visit
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}

            {canReviewCompleted && (
              <section className="space-y-2 border-t pt-3">
                {canActFromOffice || role === "dispatcher" ? (
                  <div className="flex flex-wrap gap-2">
                    {v.client_package_id && (
                      <div className="w-full space-y-1">
                        <Label htmlFor="missed-reason" className="text-xs">
                          If it was missed, why
                        </Label>
                        <select
                          id="missed-reason"
                          className="h-9 w-full rounded-md border bg-background px-2 text-sm touch:min-h-11"
                          value={missedCode}
                          onChange={(e) => setMissedCode(e.target.value as typeof missedCode)}
                        >
                          <option value="">Client no-show</option>
                          {BUSINESS_REASONS.map((code) => (
                            <option key={code} value={code}>
                              {MISSED_REASON_LABELS[code]} (no session used)
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => reopenMut.mutate()}
                      disabled={reopenMut.isPending || markMissedMut.isPending}
                    >
                      <RotateCcw className="mr-1.5 h-4 w-4 shrink-0" />
                      Reopen
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => markMissedMut.mutate()}
                      disabled={reopenMut.isPending || markMissedMut.isPending}
                    >
                      <SkipForward className="mr-1.5 h-4 w-4 shrink-0" />
                      Mark missed
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    You do not have permission to change this completed visit.
                  </p>
                )}
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function OtherVisits({
  title,
  visits,
}: {
  title: string;
  visits: Array<{
    id: string;
    scheduled_on: string;
    status: string;
    skip_reason?: string | null;
    skip_reason_code?: string | null;
  }>;
}) {
  if (visits.length === 0) return null;
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{title}</h3>
      <ul className="space-y-1 text-xs">
        {visits.map((h) => (
          <li key={h.id} className="flex justify-between gap-2">
            <span className="shrink-0">{formatDay(h.scheduled_on)}</span>
            <span className="min-w-0 text-end text-muted-foreground">
              <span className="capitalize">{i18n.t(`status.${h.status}`, { defaultValue: "Visit" })}</span>
              {h.status === "skipped" && (
                <span className="block break-words">
                  {skipReasonText(h.skip_reason, h.skip_reason_code)}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DogsSection({
  propertyId,
  dogs,
  onChanged,
}: {
  propertyId: string | undefined;
  dogs: any[];
  onChanged: () => void;
}) {
  const doAdd = useServerFn(addDog);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [breed, setBreed] = useState("");
  const [temperament, setTemperament] = useState<"friendly" | "nervous" | "aggressive" | "unknown">(
    "friendly",
  );
  const addMut = useMutation({
    mutationFn: () =>
      doAdd({
        data: {
          propertyId: propertyId!,
          name,
          breed: breed || undefined,
          temperament,
        },
      }),
    onSuccess: () => {
      toast.success("Dog added");
      setName("");
      setBreed("");
      setTemperament("friendly");
      setAdding(false);
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">
          <PawPrint className="mr-1 inline h-3 w-3 shrink-0" /> Dogs ({dogs.length})
        </h3>
        {propertyId && !adding && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => setAdding(true)}
          >
            <Plus className="mr-1 h-3 w-3 shrink-0" /> Add
          </Button>
        )}
      </div>
      {dogs.length > 0 && (
        <ul className="space-y-1 text-sm">
          {dogs.map((d: any) => (
            <li key={d.id} className="rounded border p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium">{d.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {[d.breed, d.weight_class, d.temperament].filter(Boolean).join(" · ")}
                  </div>
                  {d.notes && <div className="mt-1 text-xs">{d.notes}</div>}
                </div>
                <DogDnaControl dog={d} onChanged={onChanged} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            placeholder="Breed (optional)"
            value={breed}
            onChange={(e) => setBreed(e.target.value)}
          />
          <select
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={temperament}
            onChange={(e) => setTemperament(e.target.value as any)}
          >
            <option value="friendly">Friendly</option>
            <option value="nervous">Nervous</option>
            <option value="aggressive">Aggressive</option>
            <option value="unknown">Unknown</option>
          </select>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => addMut.mutate()}
              disabled={!name.trim() || addMut.isPending}
            >
              {addMut.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function PhotosSection({
  visitId,
  photos,
  status,
}: {
  visitId: string;
  photos: any[];
  status?: string | null;
}) {
  const qc = useQueryClient();
  const actions = useOfflineVisitActions(visitId, undefined);
  const deletePhoto = useServerFn(deleteVisitPhotoFromOffice);
  const [uploading, setUploading] = useState(false);
  // A visit nobody has started yet gets a Before photo by default (#439);
  // after that, Completion.
  const [chosenKind, setKind] = useState<PhotoKind | null>(null);
  const kind = chosenKind ?? defaultPhotoKind(status);
  const removeMut = useMutation({
    mutationFn: (photoId: string) => deletePhoto({ data: { visitId, photoId } }),
    onSuccess: () => {
      toast.success("Photo removed");
      qc.invalidateQueries({ queryKey: ["visit-detail", visitId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const r = await actions.uploadPhoto(file, kind);
      toast.success(r.queued ? "Queued: uploads when online" : "Photo uploaded");
      qc.invalidateQueries({ queryKey: ["visit-detail", visitId] });
    } catch (e: any) {
      toast.error(e?.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
        <Camera className="mr-1 inline h-3 w-3 shrink-0" /> Photos ({photos.length})
      </h3>
      {photos.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {photos.map((ph: any) => (
            <div key={ph.id} className="relative">
              <PhotoThumb path={ph.storage_path} />
              <Button
                type="button"
                size="icon"
                variant="destructive"
                className="absolute -right-2 -top-2 h-7 w-7 rounded-full"
                title="Remove photo"
                aria-label="Remove photo"
                disabled={removeMut.isPending}
                onClick={() => {
                  if (window.confirm("Remove this visit photo?")) removeMut.mutate(ph.id);
                }}
              >
                <Trash2 className="h-3.5 w-3.5 shrink-0" />
              </Button>
              <span className="absolute -bottom-1 -right-1 rounded bg-background px-1 text-3xs uppercase text-muted-foreground shadow-sm">
                {photoKindLabel(ph.kind)}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value as PhotoKind)}
          aria-label="Photo type"
        >
          {PHOTO_KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          id={`photo-input-${visitId}`}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            e.target.value = "";
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={uploading}
          onClick={async () => {
            try {
              const { isNative, takePhotoNative } = await import("@/lib/native");
              if (isNative()) {
                const blob = await takePhotoNative();
                if (blob) {
                  const file = new File([blob], `photo-${Date.now()}.jpg`, {
                    type: blob.type || "image/jpeg",
                  });
                  await upload(file);
                  return;
                }
              }
            } catch {
              /* fall through */
            }
            document.getElementById(`photo-input-${visitId}`)?.click();
          }}
        >
          <Camera className="mr-1.5 h-3.5 w-3.5 shrink-0" />
          {uploading ? "Uploading…" : "Take photo"}
        </Button>
      </div>
    </section>
  );
}

function DogDnaControl({ dog, onChanged }: { dog: any; onChanged: () => void }) {
  const setDna = useServerFn(setDogDna);
  const [editing, setEditing] = useState(false);
  const [registryId, setRegistryId] = useState<string>(dog.dna_registry_id ?? "");
  const mut = useMutation({
    mutationFn: (v: { registered: boolean; registryId?: string | null }) =>
      setDna({ data: { id: dog.id, registered: v.registered, registryId: v.registryId ?? null } }),
    onSuccess: () => {
      toast.success("DNA record updated");
      setEditing(false);
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (dog.dna_registered && !editing) {
    return (
      <div className="flex flex-col items-end text-2xs">
        <Badge
          variant="outline"
          className="border-emerald-500/60 text-emerald-700 dark:text-emerald-400"
        >
          DNA ✓
        </Badge>
        {dog.dna_registry_id && (
          <span className="mt-0.5 text-muted-foreground">{dog.dna_registry_id}</span>
        )}
        <button
          className="mt-0.5 text-3xs text-muted-foreground underline"
          onClick={() => setEditing(true)}
        >
          edit
        </button>
      </div>
    );
  }
  if (!editing) {
    return (
      <button
        className="text-2xs text-muted-foreground underline"
        onClick={() => setEditing(true)}
        disabled={mut.isPending}
      >
        + DNA
      </button>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Input
        className="h-7 w-32 text-xs"
        placeholder="Registry ID"
        value={registryId}
        onChange={(e) => setRegistryId(e.target.value)}
      />
      <div className="flex gap-1">
        <Button
          size="sm"
          className="h-6 px-2 text-2xs"
          onClick={() => mut.mutate({ registered: true, registryId })}
          disabled={mut.isPending}
        >
          Save
        </Button>
        {dog.dna_registered && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-2xs"
            onClick={() => mut.mutate({ registered: false })}
            disabled={mut.isPending}
          >
            Clear
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-2xs"
          onClick={() => setEditing(false)}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
