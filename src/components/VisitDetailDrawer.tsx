import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
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
import { getVisitDetail } from "@/lib/visits.functions";
import { completeVisit, startVisit, skipVisit } from "@/lib/my-day.functions";
import { addDog } from "@/lib/dogs.functions";
import { useOfflineVisitActions } from "@/lib/offline/useOfflineVisitActions";
import { Input } from "@/components/ui/input";
import {
  Navigation,
  CheckCircle2,
  PlayCircle,
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
  if (!url) return <div className="h-16 w-16 animate-pulse rounded bg-muted" />;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="Visit" className="h-16 w-16 rounded border object-cover" />
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
  const qc = useQueryClient();
  const getDetail = useServerFn(getVisitDetail);
  const doComplete = useServerFn(completeVisit);
  const doStart = useServerFn(startVisit);
  const doSkip = useServerFn(skipVisit);

  const { data, isLoading } = useQuery({
    enabled: !!visitId,
    queryKey: ["visit-detail", visitId],
    queryFn: () => getDetail({ data: { visitId: visitId! } }),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["visit-detail", visitId] });
    qc.invalidateQueries({ queryKey: ["visits"] });
  };

  const startMut = useMutation({
    mutationFn: () => doStart({ data: { visitId: visitId! } }),
    onSuccess: () => { toast.success("Visit started"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const completeMut = useMutation({
    mutationFn: () => doComplete({ data: { visitId: visitId! } }),
    onSuccess: () => { toast.success("Visit completed"); invalidate(); onOpenChange(false); },
    onError: (e: Error) => toast.error(e.message),
  });
  const [skipReason, setSkipReason] = useState("");
  const skipMut = useMutation({
    mutationFn: () => doSkip({ data: { visitId: visitId!, reason: skipReason || "Skipped from dispatch", code: "other" } }),
    onSuccess: () => { toast.success("Visit skipped"); invalidate(); onOpenChange(false); },
    onError: (e: Error) => toast.error(e.message),
  });

  const v: any = data?.visit;
  const p = v?.properties;
  const client = v?.clients;
  const dogs = data?.dogs ?? [];
  const history = data?.history ?? [];
  const hazards = hazardList(p);
  const dir = directionsUrl(p);
  const canStart = v?.status === "scheduled";
  const canComplete = v?.status === "scheduled" || v?.status === "in_progress";
  const canSkip = v?.status === "scheduled" || v?.status === "in_progress";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
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
            {v?.scheduled_on} {v?.zones?.name ? `· ${v.zones.name}` : ""}
            {v?.staff?.display_name ? ` · ${v.staff.display_name}` : ""}
          </SheetDescription>
        </SheetHeader>

        {isLoading || !v ? (
          <div className="flex justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {hazards.length > 0 && (
              <div className="rounded-md border-2 border-destructive/50 bg-destructive/10 p-3 text-sm">
                <div className="flex items-center gap-2 font-semibold text-destructive">
                  <AlertTriangle className="h-4 w-4" /> Safety notes
                </div>
                <ul className="mt-1 list-disc pl-6 text-destructive">
                  {hazards.map((h) => <li key={h}>{h}</li>)}
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
                    <Button size="sm" variant="outline"><Navigation className="mr-1.5 h-3.5 w-3.5" />Directions</Button>
                  </a>
                )}
                {client?.primary_phone && (
                  <a href={`tel:${client.primary_phone}`}>
                    <Button size="sm" variant="outline"><Phone className="mr-1.5 h-3.5 w-3.5" />Call</Button>
                  </a>
                )}
                {client?.primary_email && (
                  <a href={`mailto:${client.primary_email}`}>
                    <Button size="sm" variant="outline"><Mail className="mr-1.5 h-3.5 w-3.5" />Email</Button>
                  </a>
                )}
                <Link to="/clients/$clientId" params={{ clientId: v.client_id }} onClick={() => onOpenChange(false)}>
                  <Button size="sm" variant="ghost"><ExternalLink className="mr-1.5 h-3.5 w-3.5" />Open client</Button>
                </Link>
              </div>
              {(p?.gate_code || p?.lock_box_code || p?.key_location) && (
                <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-2 text-xs">
                  {p.gate_code && <div><span className="text-muted-foreground">Gate:</span> <span className="font-mono">{p.gate_code}</span></div>}
                  {p.lock_box_code && <div><span className="text-muted-foreground">Lock box:</span> <span className="font-mono">{p.lock_box_code}</span></div>}
                  {p.key_location && <div className="col-span-2"><span className="text-muted-foreground">Key:</span> {p.key_location}</div>}
                </div>
              )}
              {(p?.parking_notes || p?.access_notes) && (
                <div className="rounded-md border p-2 text-xs">
                  {p.parking_notes && <div><span className="text-muted-foreground">Parking:</span> {p.parking_notes}</div>}
                  {p.access_notes && <div><span className="text-muted-foreground">Access:</span> {p.access_notes}</div>}
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
                {v.eta_start && <div>ETA {new Date(v.eta_start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>}
                {v.travel_km != null && <div>Drive {Number(v.travel_km).toFixed(1)} km · {Math.round(Number(v.travel_min ?? 0))} min</div>}
                {v.window_violated && <Badge variant="destructive" className="mt-1">Outside window</Badge>}
              </section>
            )}

            {(v.skip_reason || v.weather_note) && (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Notes</h3>
                {v.weather_note && <p className="whitespace-pre-wrap text-sm">{v.weather_note}</p>}
                {v.skip_reason && <p className="mt-1 text-sm text-muted-foreground">Skip: {v.skip_reason}</p>}
              </section>
            )}

            {v.visit_photos?.length > 0 && (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Photos</h3>
                <div className="flex flex-wrap gap-2">
                  {v.visit_photos.map((ph: any) => (
                    <div key={ph.id} className="relative">
                      <PhotoThumb path={ph.storage_path} />
                      <span className="absolute -bottom-1 -right-1 rounded bg-background px-1 text-[9px] uppercase text-muted-foreground shadow-sm">
                        {ph.kind}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {history.length > 0 && (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Recent visits</h3>
                <ul className="space-y-1 text-xs">
                  {history.map((h: any) => (
                    <li key={h.id} className="flex justify-between">
                      <span>{h.scheduled_on}</span>
                      <span className="capitalize text-muted-foreground">{h.status.replace("_", " ")}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {(canStart || canComplete || canSkip) && (
              <section className="space-y-2 border-t pt-3">
                <div className="flex flex-wrap gap-2">
                  {canStart && (
                    <Button size="sm" variant="outline" onClick={() => startMut.mutate()} disabled={startMut.isPending}>
                      <PlayCircle className="mr-1.5 h-4 w-4" />Start
                    </Button>
                  )}
                  {canComplete && (
                    <Button size="sm" onClick={() => completeMut.mutate()} disabled={completeMut.isPending}>
                      <CheckCircle2 className="mr-1.5 h-4 w-4" />Complete
                    </Button>
                  )}
                </div>
                {canSkip && (
                  <div className="space-y-1">
                    <Label htmlFor="skip" className="text-xs">Skip reason</Label>
                    <Textarea
                      id="skip"
                      rows={2}
                      value={skipReason}
                      onChange={(e) => setSkipReason(e.target.value)}
                      placeholder="Gate locked, dog outside, weather…"
                    />
                    <Button size="sm" variant="destructive" onClick={() => skipMut.mutate()} disabled={skipMut.isPending || !skipReason.trim()}>
                      <SkipForward className="mr-1.5 h-4 w-4" />Skip visit
                    </Button>
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
