import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { useSignedUrl } from "@/hooks/useSignedUrl";
import { useOrgTimezone, useOrgToday } from "@/hooks/useOrgToday";
import { orgLocalTime } from "@/lib/org-day";
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
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { PHOTO_KIND_OPTIONS, photoKindLabel, type PhotoKind } from "@/lib/photo-kinds";
import { parseAnswers } from "@/lib/visit-checklist";
import { VisitChecklistAnswers } from "@/components/VisitChecklistAnswers";

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
    onSuccess: () => {
      toast.success(`Visit moved to ${formatDay(moveTo)}`);
      setMoveTo("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reassignMut = useMutation({
    mutationFn: (staffId: string | null) => doReassign({ data: { visitId: visitId!, staffId } }),
    onSuccess: () => {
      toast.success("Visit reassigned");
      invalidate();
      // The board and the mobile day list both key off "visits"; invalidate()
      // covers those, but the tech lanes are grouped client-side from the same
      // query so no extra refetch is needed.
    },
    onError: (e: Error) => toast.error(e.message),
  });

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
  const cancelMut = useMutation({
    // The office variant requires a reason — no silent "Skipped from dispatch"
    // default, because that string was being written to real visits as if a
    // human had given it.
    mutationFn: () => doCancel({ data: { visitId: visitId!, reason: skipReason, code: "other" } }),
    onSuccess: () => {
      toast.success("Visit canceled");
      invalidate();
      onOpenChange(false);
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
                {v.status.replace("_", " ")}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            {formatDay(v?.scheduled_on)} {v?.zones?.name ? `· ${v.zones.name}` : ""}
            {v?.staff?.display_name ? ` · ${v.staff.display_name}` : ""}
          </SheetDescription>
        </SheetHeader>

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

            {(v.eta_start || v.travel_min != null) && (
              <section className="rounded-md border p-2 text-xs">
                {v.eta_start && <div>ETA {orgLocalTime(v.eta_start, tz)}</div>}
                {v.travel_km != null && (
                  <div>
                    Drive {Number(v.travel_km).toFixed(1)} km ·{" "}
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
                {v.skip_reason && (
                  <p className="mt-1 text-sm text-muted-foreground">Skip: {v.skip_reason}</p>
                )}
              </section>
            )}

            {/* What the tech confirmed, with the labels as they read the day
                the visit was completed. Absent when nothing asked. */}
            <VisitChecklistAnswers answers={parseAnswers(v.visit_checklist) ?? []} />

            <PhotosSection visitId={visitId!} photos={v.visit_photos ?? []} />

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
                <select
                  id="reassign"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={v?.assigned_staff_id ?? ""}
                  disabled={reassignMut.isPending}
                  onChange={(e) => reassignMut.mutate(e.target.value || null)}
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
                      The visit leaves this route. Dispatch or auto-routing places it on the new
                      day. Reordering a tech's stops is on the Schedule board.
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
  visits: Array<{ id: string; scheduled_on: string; status: string }>;
}) {
  if (visits.length === 0) return null;
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{title}</h3>
      <ul className="space-y-1 text-xs">
        {visits.map((h) => (
          <li key={h.id} className="flex justify-between gap-2">
            <span>{formatDay(h.scheduled_on)}</span>
            <span className="capitalize text-muted-foreground">{h.status.replace("_", " ")}</span>
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

function PhotosSection({ visitId, photos }: { visitId: string; photos: any[] }) {
  const qc = useQueryClient();
  const actions = useOfflineVisitActions(visitId, undefined);
  const [uploading, setUploading] = useState(false);
  const [kind, setKind] = useState<PhotoKind>("completion");

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
