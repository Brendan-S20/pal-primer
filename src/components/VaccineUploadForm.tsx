import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { VACCINES, VACCINE_LABELS, VACCINE_MIME_EXT, type Vaccine } from "@/lib/vaccines";

export function VaccineUploadForm({
  dogId,
  busy,
  requireFile = false,
  onSave,
}: {
  dogId: string;
  busy: boolean;
  requireFile?: boolean;
  onSave: (data: FormData) => Promise<void>;
}) {
  const [vaccine, setVaccine] = useState<Vaccine>("rabies");
  const prefix = `vaccine-${dogId}`;
  return (
    <form
      className="space-y-3 border-t pt-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        try {
          await onSave(new FormData(form));
          form.reset();
          setVaccine("rabies");
        } catch {
          /* The caller shows the save error. */
        }
      }}
    >
      <h3 className="font-medium">
        {requireFile ? "Upload vaccine proof" : "Add a vaccine record"}
      </h3>
      <input type="hidden" name="dogId" value={dogId} />
      <div className="space-y-1">
        <Label htmlFor={`${prefix}-type`}>Vaccine</Label>
        <select
          id={`${prefix}-type`}
          name="vaccine"
          value={vaccine}
          onChange={(e) => setVaccine(e.target.value as Vaccine)}
          className="min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
        >
          {VACCINES.map((v) => (
            <option key={v} value={v}>
              {VACCINE_LABELS[v]}
            </option>
          ))}
        </select>
      </div>
      {vaccine === "other" && (
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-note`}>Vaccine name</Label>
          <Input
            id={`${prefix}-note`}
            name="vaccineNote"
            maxLength={80}
            required
            className="min-h-11"
          />
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${prefix}-given`}>Given on (optional)</Label>
          <Input
            id={`${prefix}-given`}
            name="givenOn"
            type="date"
            className="min-h-11 w-full min-w-0"
          />
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${prefix}-expires`}>Expires on</Label>
          <Input
            id={`${prefix}-expires`}
            name="expiresOn"
            type="date"
            required
            className="min-h-11 w-full min-w-0"
          />
        </div>
      </div>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={`${prefix}-file`}>Photo or PDF{requireFile ? "" : " (optional)"}</Label>
        <Input
          id={`${prefix}-file`}
          name="file"
          type="file"
          accept={Object.keys(VACCINE_MIME_EXT).join(",")}
          required={requireFile}
          className="min-h-11 w-full min-w-0"
        />
        <p className="text-xs text-muted-foreground">
          JPEG, PNG, WebP, HEIC, HEIF or PDF. Up to 10 MB.
        </p>
      </div>
      {!requireFile && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="proofSeen" />
          Proof seen
        </label>
      )}
      <Button type="submit" disabled={busy} className="min-h-11">
        {busy ? "Saving…" : requireFile ? "Upload record" : "Add record"}
      </Button>
    </form>
  );
}
