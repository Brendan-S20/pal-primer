import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getOrgBranding } from "@/lib/org.functions";
import { createZone, geocodePostal } from "@/lib/zones.functions";
import {
  setupAreaCenter,
  setupAreaCenterProblem,
  setupAreaZipValue,
  zip5,
  zipFromAddress,
} from "@/lib/setup-area-center";
import {
  SETUP_AREA_DEFAULT_NAME,
  SETUP_AREA_MILES,
  setupServiceAreaZone,
} from "@/lib/setup-service-area";
import { stepSave } from "@/lib/setup-step-save";

// ── /setup, step 2: where a walker, sitter, groomer or trainer works (#958) ──
//
// The pet-waste form asks for a price per visit, an extra-dog price and a
// first cleanup, none of which a walk, a stay, a groom or a lesson reads
// (R2-47). This asks only WHERE: the ZIP at the middle and how far, filled
// the same way (#946, #858). See lib/setup-service-area.
//
// Office-only (owner, office manager), so English.

export function ServiceAreaOnlyForm({
  done,
  onSaved,
  saveLabel = "Save and continue",
}: {
  done: boolean;
  onSaved: () => void;
  saveLabel?: string;
}) {
  const qc = useQueryClient();
  const brandingFn = useServerFn(getOrgBranding);
  const brandingQ = useQuery({ queryKey: ["org-branding"], queryFn: () => brandingFn() });
  const createFn = useServerFn(createZone);
  const postalFn = useServerFn(geocodePostal);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(SETUP_AREA_DEFAULT_NAME);
  const [miles, setMiles] = useState<number>(15);
  const [zip, setZip] = useState("");
  const [zipEdited, setZipEdited] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A retry after a failed refresh does not make a second zone.
  const createdZone = useRef<string | null>(null);

  const b = brandingQ.data;
  const pin =
    b?.latitude != null && b?.longitude != null
      ? { lat: Number(b.latitude), lng: Number(b.longitude) }
      : null;
  const businessZip = zipFromAddress(b?.contact_address);
  const zipVal = setupAreaZipValue({
    typed: zip,
    edited: zipEdited,
    businessAddress: b?.contact_address,
  });

  const m = useMutation(
    stepSave({
      qc,
      save: async () => {
        if (createdZone.current) return;
        const center = await setupAreaCenter({
          zip: zipVal,
          businessAddress: b?.contact_address,
          pin,
          geocode: async (postalCode) => {
            const r = await postalFn({ data: { postalCode } });
            return r.point ? { lat: r.point.latitude, lng: r.point.longitude } : null;
          },
        });
        const zone = await createFn({ data: setupServiceAreaZone({ name, center, miles }) });
        createdZone.current = zone.id;
      },
      refresh: [["zones"], ["zone-coverage"]],
      saved: () => {
        createdZone.current = null;
        setFailure(null);
        setAdding(false);
        toast.success("Service area saved");
      },
      onFailed: setFailure,
      onSaved,
    }),
  );

  if (done && !adding) {
    return (
      <div className="space-y-3" data-setup-service-area-done>
        <p className="text-sm">
          Clients inside your service area can book online. Areas can be changed on{" "}
          <Link to="/zones" className="underline">
            Zones
          </Link>
          .
        </p>
        <Button type="button" variant="outline" onClick={() => setAdding(true)}>
          Add another area
        </Button>
      </div>
    );
  }

  const refuse = (message: string) => {
    setFailure(message);
    toast.error(message);
  };

  return (
    <form
      className="space-y-4"
      data-setup-service-area-form
      onSubmit={(e) => {
        e.preventDefault();
        if (m.isPending) return;
        const problem = setupAreaCenterProblem({ zip: zipVal, pin });
        if (problem) return refuse(problem);
        setFailure(null);
        m.mutate();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="setup-area-name">Area name</Label>
        <Input
          id="setup-area-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="setup-area-zip">ZIP code at the middle of your area</Label>
        <Input
          id="setup-area-zip"
          className="max-w-40"
          inputMode="numeric"
          value={zipVal}
          onChange={(e) => {
            setZipEdited(true);
            setZip(e.target.value);
          }}
          maxLength={10}
          autoComplete="postal-code"
          aria-describedby="setup-area-zip-hint"
        />
        <p id="setup-area-zip-hint" className="text-xs text-muted-foreground">
          {businessZip && zip5(zipVal) === businessZip
            ? "From your business address. Change it to center the area somewhere else."
            : "The area is a circle around this ZIP. The ZIPs inside it are listed for you."}
        </p>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">How far you travel</legend>
        <div className="flex flex-wrap gap-2 pt-1.5">
          {SETUP_AREA_MILES.map((n) => (
            <Button
              key={n}
              type="button"
              size="sm"
              variant={miles === n ? "default" : "outline"}
              aria-pressed={miles === n}
              onClick={() => setMiles(n)}
            >
              {n} miles
            </Button>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Clients inside the area can book online. Anyone outside it is told you don't serve their
        area yet. You can draw more areas on{" "}
        <Link to="/zones" className="underline">
          Zones
        </Link>{" "}
        later.
      </p>
      {failure && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          data-setup-error
        >
          {failure}
        </p>
      )}
      <Button type="submit" disabled={m.isPending} data-setup-action="save-area">
        {m.isPending ? "Saving…" : saveLabel}
      </Button>
    </form>
  );
}
