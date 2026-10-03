import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useMyRole } from "@/hooks/useMyRole";
import {
  listManifests,
  createManifest,
  deleteManifest,
  listFacilities,
  upsertFacility,
} from "@/lib/stations.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { HelpTip } from "@/components/HelpTip";
import { formatDay } from "@/lib/format";
import { useIntlLocale } from "@/lib/i18n";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { Camera, Plus, X } from "lucide-react";
import { pageTitle, useDocumentTitle } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/waste-log")({
  head: () => ({ meta: [{ title: pageTitle("Waste log") }] }),
  component: WasteLogPage,
});

function WasteLogPage() {
  const { t } = useTranslation();
  // In the language this device reads. The route's head is English because
  // it runs before i18n has read the device's choice.
  useDocumentTitle(pageTitle(t("nav.item.waste-log")));
  const locale = useIntlLocale();
  const qc = useQueryClient();
  const listMans = useServerFn(listManifests);
  const listFacs = useServerFn(listFacilities);
  const createFn = useServerFn(createManifest);
  const delFn = useServerFn(deleteManifest);
  const upsertFacFn = useServerFn(upsertFacility);

  const mans = useQuery({ queryKey: ["waste-manifests"], queryFn: () => listMans({ data: {} }) });
  const facs = useQuery({ queryKey: ["waste-facilities"], queryFn: () => listFacs() });

  const { orgId } = useMyRole();
  const [draft, setDraft] = useState({
    facilityId: "" as string,
    disposedOn: new Date().toISOString().slice(0, 10),
    weightLbs: "" as string,
    bagCount: "" as string,
    ticketNumber: "",
    notes: "",
  });
  const [receipt, setReceipt] = useState<File | null>(null);
  const [newFacility, setNewFacility] = useState({ name: "", address: "" });
  // The log form is collapsed by default (D polish) — matches the rest of the
  // app, where entry forms open on demand rather than always occupying the page.
  const [showForm, setShowForm] = useState(false);

  const createMut = useMutation({
    // Receipt photo (punch list #16): compress + upload to the org-scoped
    // waste-receipts bucket, then store the path on the manifest.
    mutationFn: async (v: any) => {
      let photoUrl: string | undefined;
      if (receipt) {
        if (!orgId) throw new Error(t("wasteLog.orgLoading"));
        const { compressImage } = await import("@/lib/offline/compressImage");
        const { file, contentType, ext } = await compressImage(receipt);
        const path = `${orgId}/${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from("waste-receipts")
          .upload(path, file, { contentType, upsert: false });
        // The storage error itself is shown as the server wrote it.
        if (upErr) throw new Error(t("wasteLog.receiptUploadFailed", { message: upErr.message }));
        photoUrl = path;
      }
      return createFn({ data: { ...v, photoUrl } });
    },
    onSuccess: () => {
      toast.success(t("wasteLog.manifestLogged"));
      qc.invalidateQueries({ queryKey: ["waste-manifests"] });
      setDraft({
        facilityId: draft.facilityId,
        disposedOn: draft.disposedOn,
        weightLbs: "",
        bagCount: "",
        ticketNumber: "",
        notes: "",
      });
      setReceipt(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => {
      toast.success(t("wasteLog.deleted"));
      qc.invalidateQueries({ queryKey: ["waste-manifests"] });
    },
  });
  const facMut = useMutation({
    mutationFn: (v: any) => upsertFacFn({ data: v }),
    onSuccess: () => {
      toast.success(t("wasteLog.facilityAdded"));
      qc.invalidateQueries({ queryKey: ["waste-facilities"] });
      setNewFacility({ name: "", address: "" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const manifests: any[] = mans.data?.manifests ?? [];
  const facilities: any[] = facs.data?.facilities ?? [];
  const totalLbs = manifests.reduce((s, m) => s + Number(m.weight_lbs ?? 0), 0);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight md:text-xl md:font-semibold">
            {t("wasteLog.title")} <HelpTip article="waste-log" />
          </h1>
          <p className="text-sm text-muted-foreground">{t("wasteLog.subtitle")}</p>
        </div>
        <Badge variant="secondary">
          {t("wasteLog.recentTotal", { weight: totalLbs.toFixed(0) })}
        </Badge>
      </div>

      <section className="rounded-lg border bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">{t("wasteLog.logADump")}</h2>
          <Button
            size="sm"
            variant={showForm ? "ghost" : "outline"}
            onClick={() => setShowForm((v) => !v)}
            // Visible "Add" beside the "Log a dump" heading; the accessible name
            // carries the whole action for a screen reader.
            aria-label={showForm ? t("wasteLog.closeLogADump") : t("wasteLog.logADump")}
            aria-expanded={showForm}
          >
            {showForm ? (
              <>
                <X className="mr-1.5 h-4 w-4 shrink-0" /> {t("common.close")}
              </>
            ) : (
              <>
                <Plus className="mr-1.5 h-4 w-4 shrink-0" /> {t("common.add")}
              </>
            )}
          </Button>
        </div>
        {showForm && (
        <form
          className="mt-3 grid gap-3 sm:grid-cols-6"
          onSubmit={(e) => {
            e.preventDefault();
            createMut.mutate({
              facilityId: draft.facilityId || null,
              disposedOn: draft.disposedOn,
              weightLbs: draft.weightLbs ? Number(draft.weightLbs) : undefined,
              bagCount: draft.bagCount ? parseInt(draft.bagCount, 10) : undefined,
              ticketNumber: draft.ticketNumber || undefined,
              notes: draft.notes || undefined,
            });
          }}
        >
          <div className="sm:col-span-2">
            <Label htmlFor="dump-facility">{t("wasteLog.facility")}</Label>
            <select
              id="dump-facility"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={draft.facilityId}
              onChange={(e) => setDraft({ ...draft, facilityId: e.target.value })}
            >
              <option value="">{t("wasteLog.selectFacility")}</option>
              {facilities
                .filter((f) => f.active)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <Label htmlFor="dump-date">{t("wasteLog.date")}</Label>
            <Input
              id="dump-date"
              type="date"
              value={draft.disposedOn}
              onChange={(e) => setDraft({ ...draft, disposedOn: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="dump-weight">{t("wasteLog.weightLbs")}</Label>
            <Input
              id="dump-weight"
              inputMode="decimal"
              type="number"
              step="0.1"
              min="0"
              value={draft.weightLbs}
              onChange={(e) => setDraft({ ...draft, weightLbs: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="dump-bags">{t("wasteLog.bags")}</Label>
            <Input
              id="dump-bags"
              inputMode="numeric"
              type="number"
              min="0"
              value={draft.bagCount}
              onChange={(e) => setDraft({ ...draft, bagCount: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="dump-ticket">{t("wasteLog.ticket")}</Label>
            <Input
              id="dump-ticket"
              value={draft.ticketNumber}
              onChange={(e) => setDraft({ ...draft, ticketNumber: e.target.value })}
            />
          </div>
          <div className="sm:col-span-6">
            <Label htmlFor="dump-notes">{t("myDay.notes")}</Label>
            <Textarea
              id="dump-notes"
              rows={2}
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </div>
          <div className="sm:col-span-6">
            <Label>{t("wasteLog.receiptPhoto")}</Label>
            <div className="mt-1 flex items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground transition hover:border-primary hover:bg-accent">
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
                />
                <Camera className="h-4 w-4 shrink-0" />
                {receipt ? t("wasteLog.changePhoto") : t("wasteLog.addReceiptPhoto")}
              </label>
              {receipt && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {receipt.name}
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-muted"
                    onClick={() => setReceipt(null)}
                    aria-label={t("wasteLog.removeReceipt")}
                  >
                    <X className="h-3.5 w-3.5 shrink-0" />
                  </button>
                </span>
              )}
            </div>
          </div>
          <div className="sm:col-span-6">
            <Button type="submit" disabled={createMut.isPending}>
              {createMut.isPending ? t("common.logging") : t("wasteLog.logDump")}
            </Button>
          </div>
        </form>
        )}
      </section>

      <section className="rounded-lg border bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">{t("wasteLog.facilities")}</h2>
        </div>
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newFacility.name) return;
            facMut.mutate(newFacility);
          }}
        >
          <div className="flex-1 min-w-40">
            <Label htmlFor="facility-name">{t("wasteLog.name")}</Label>
            <Input
              id="facility-name"
              value={newFacility.name}
              onChange={(e) => setNewFacility({ ...newFacility, name: e.target.value })}
              placeholder={t("wasteLog.namePlaceholder")}
            />
          </div>
          {/* min-w-40 and flex-1, so the field and the dropdown it hangs over
              stay inside a 360px viewport instead of setting the row's width.
              Judgement call on this one field: a transfer station is not a
              customer address, and the provider is restricted to
              street_address/premise/subpremise (google-places.server.ts), so
              typing "Northside Transfer Station" by name will match nothing —
              a street address for it will. That is not a reason to leave the
              field plain: `saveFacility` geocodes whatever string is here and
              the route planner uses the result as a fallback end point, so a
              matched address is worth more here than on most fields, and a
              name typed by hand still saves exactly as it does today. The
              workspace bias is right too — the dump is near the routes. */}
          <div className="flex-1 min-w-40">
            <Label>{t("wasteLog.address")}</Label>
            <AddressAutocomplete
              value={newFacility.address}
              onChangeText={(text) => setNewFacility({ ...newFacility, address: text })}
              onResolved={(r) => setNewFacility({ ...newFacility, address: r.address.formatted })}
            />
          </div>
          <Button type="submit" disabled={facMut.isPending}>
            {t("common.add")}
          </Button>
        </form>
        {facilities.length > 0 && (
          <ul className="mt-3 divide-y text-sm">
            {facilities.map((f) => (
              <li key={f.id} className="flex items-center justify-between py-2">
                <div>
                  <div className="font-medium">
                    {f.name}
                    {!f.active && (
                      <Badge variant="outline" className="ml-2">
                        {t("wasteLog.inactive")}
                      </Badge>
                    )}
                  </div>
                  {f.address && <div className="text-xs text-muted-foreground">{f.address}</div>}
                </div>
                {f.address && (
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(f.address)}&travelmode=driving`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary underline"
                  >
                    {t("myDay.directions")}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-medium">{t("wasteLog.recentManifests")}</h2>
        {manifests.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t("wasteLog.noManifests")}</p>
        ) : (
          <ul className="mt-3 divide-y text-sm">
            {manifests.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <div className="font-medium">
                    {formatDay(m.disposed_on, locale)}
                    {" · "}
                    {m.waste_disposal_facilities?.name || t("wasteLog.noFacility")}
                    {m.ticket_number && (
                      <span className="ml-2 text-xs text-muted-foreground">#{m.ticket_number}</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {m.weight_lbs ? t("wasteLog.weight", { weight: m.weight_lbs }) : ""}
                    {m.bag_count ? ` · ${t("wasteLog.bagCount", { count: m.bag_count })}` : ""}
                    {m.staff?.display_name ? ` · ${m.staff.display_name}` : ""}
                  </div>
                  {m.notes && <div className="text-xs text-muted-foreground">{m.notes}</div>}
                </div>
                <div className="flex items-center gap-1">
                  {m.photo_url && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const { data, error } = await supabase.storage
                          .from("waste-receipts")
                          .createSignedUrl(m.photo_url, 300);
                        if (error || !data?.signedUrl) {
                          toast.error(t("wasteLog.couldNotOpenReceipt"));
                          return;
                        }
                        window.open(data.signedUrl, "_blank", "noreferrer");
                      }}
                    >
                      {t("wasteLog.receipt")}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => delMut.mutate(m.id)}>
                    {t("common.delete")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        <Link to="/my-day" className="underline">
          {t("wasteLog.backToMyDay")}
        </Link>
      </p>
    </>
  );
}
