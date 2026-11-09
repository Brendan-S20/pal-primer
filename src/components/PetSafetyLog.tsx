import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { addPetSafetyEntry, listPetSafetyEntries } from "@/lib/pet-safety.functions";
import {
  PET_INCIDENT_KINDS,
  PET_SAFETY_BODY_MAX,
  PET_SAFETY_MIME_EXT,
  type PetIncidentKind,
  type PetSafetyEntryType,
} from "@/lib/pet-safety";

/** The local wall-clock value a datetime-local input wants, for "now". */
function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/**
 * A pet's safety notes and incident log (#729): a button that says how many
 * incidents are on file, and a dialog that lists every entry (when, what
 * kind, who reported it, the photo) and adds a new one. Append-only: there is
 * no edit and no delete, because the log is the audit trail.
 *
 * Used on the office's pet card and on the tech's client view, so every word
 * goes through t() (CLAUDE.md, "A tech's screen speaks the tech's language").
 */
export function PetSafetyLog({
  dogId,
  name,
  visitId,
}: {
  dogId: string;
  name: string;
  /** The visit this was reported from, when there is one. */
  visitId?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const list = useServerFn(listPetSafetyEntries);
  const add = useServerFn(addPetSafetyEntry);
  const entries = useQuery({
    queryKey: ["pet-safety", dogId],
    queryFn: () => list({ data: { dogId } }),
    staleTime: 60_000,
  });
  const [entryType, setEntryType] = useState<PetSafetyEntryType>("incident");
  const [kind, setKind] = useState<PetIncidentKind>("bite");
  const [occurredAt, setOccurredAt] = useState(localNow);
  const [body, setBody] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.set("dogId", dogId);
      form.set("entryType", entryType);
      if (entryType === "incident") form.set("incidentKind", kind);
      if (occurredAt) form.set("occurredAt", new Date(occurredAt).toISOString());
      form.set("body", body);
      if (visitId) form.set("visitId", visitId);
      if (photo) form.set("photo", photo);
      return add({ data: form });
    },
    onSuccess: () => {
      toast.success(t("petSafety.saved"));
      setBody("");
      setPhoto(null);
      setOccurredAt(localNow());
      qc.invalidateQueries({ queryKey: ["pet-safety", dogId] });
    },
    onError: () => toast.error(t("petSafety.notSaved")),
  });
  const rows = entries.data ?? [];
  const incidents = rows.filter((r) => r.entry_type === "incident").length;
  const when = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language || undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" className="min-h-11" onClick={() => setOpen(true)}>
        <ShieldAlert className="me-1 h-4 w-4 shrink-0" aria-hidden />
        {t("petSafety.open")}
      </Button>
      {incidents > 0 && (
        <Badge variant="destructive">{t("petSafety.incidentCount", { count: incidents })}</Badge>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {t("petSafety.title")}: <bdi>{name}</bdi>
            </DialogTitle>
            <DialogDescription>{t("petSafety.description")}</DialogDescription>
          </DialogHeader>

          <form
            className="space-y-3 rounded-md border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (body.trim()) save.mutate();
            }}
          >
            <fieldset className="flex flex-wrap gap-2">
              <legend className="sr-only">{t("petSafety.entryType")}</legend>
              {(["incident", "note"] as const).map((type) => (
                <Button
                  key={type}
                  type="button"
                  size="sm"
                  variant={entryType === type ? "default" : "outline"}
                  className="min-h-11"
                  aria-pressed={entryType === type}
                  onClick={() => setEntryType(type)}
                >
                  {t(`petSafety.type.${type}`)}
                </Button>
              ))}
            </fieldset>
            {entryType === "incident" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="min-w-0 space-y-1">
                  <Label htmlFor={`pet-safety-kind-${dogId}`}>{t("petSafety.kindLabel")}</Label>
                  <select
                    id={`pet-safety-kind-${dogId}`}
                    value={kind}
                    onChange={(e) => setKind(e.target.value as PetIncidentKind)}
                    className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    {PET_INCIDENT_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(`petSafety.kind.${k}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="min-w-0 space-y-1">
                  <Label htmlFor={`pet-safety-when-${dogId}`}>{t("petSafety.when")}</Label>
                  <Input
                    id={`pet-safety-when-${dogId}`}
                    type="datetime-local"
                    value={occurredAt}
                    max={localNow()}
                    onChange={(e) => setOccurredAt(e.target.value)}
                    className="min-h-11"
                  />
                </div>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor={`pet-safety-body-${dogId}`}>
                {entryType === "incident" ? t("petSafety.whatHappened") : t("petSafety.note")}
              </Label>
              <Textarea
                id={`pet-safety-body-${dogId}`}
                value={body}
                maxLength={PET_SAFETY_BODY_MAX}
                onChange={(e) => setBody(e.target.value)}
                required
              />
            </div>
            {entryType === "incident" && (
              <div className="space-y-1">
                <Label htmlFor={`pet-safety-photo-${dogId}`}>{t("petSafety.photo")}</Label>
                <Input
                  id={`pet-safety-photo-${dogId}`}
                  type="file"
                  accept={Object.keys(PET_SAFETY_MIME_EXT).join(",")}
                  capture="environment"
                  onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                  className="min-h-11"
                />
              </div>
            )}
            <Button type="submit" className="min-h-11" disabled={save.isPending || !body.trim()}>
              {t("petSafety.save")}
            </Button>
          </form>

          {entries.isLoading && <p className="text-sm">{t("petSafety.loading")}</p>}
          {entries.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t("petSafety.loadFailed")}
            </p>
          )}
          {entries.isSuccess && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("petSafety.empty")}</p>
          )}
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.id} className="min-w-0 space-y-1 rounded-md border p-3 text-sm">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant={r.entry_type === "incident" ? "destructive" : "secondary"}>
                    {r.entry_type === "incident"
                      ? t(`petSafety.kind.${r.incident_kind}`, {
                          defaultValue: t("petSafety.type.incident"),
                        })
                      : t("petSafety.type.note")}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{when(r.occurred_at)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words">
                  <bdi>{r.body}</bdi>
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("petSafety.reportedBy")} <bdi>{r.reporter_name}</bdi>
                </p>
                {r.photoUrl && (
                  <a href={r.photoUrl} target="_blank" rel="noreferrer" className="block">
                    <img
                      src={r.photoUrl}
                      alt={t("petSafety.photoAlt")}
                      className="max-h-48 max-w-full rounded-md border object-contain"
                    />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
