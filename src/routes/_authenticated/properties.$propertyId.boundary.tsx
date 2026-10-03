import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getPropertyBoundary, updatePropertyBoundary } from "@/lib/properties.functions";
import { BoundarySketch, formatArea, type PolygonGeoJSON } from "@/components/BoundarySketch";
import { YARD_SIZE_LABELS, type YardSizeCategory } from "@/lib/yard-size";
import { humanizeEnum } from "@/lib/humanize";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/properties/$propertyId/boundary")({
  head: () => titleHead("Property boundary"),
  // Wide — see src/components/PageShell.tsx. A map you draw a yard boundary on.
  staticData: { pageWidth: "wide" },
  component: BoundaryPage,
});

function BoundaryPage() {
  const { propertyId } = Route.useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const get = useServerFn(getPropertyBoundary);
  const save = useServerFn(updatePropertyBoundary);
  const [justSaved, setJustSaved] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["property-boundary", propertyId],
    queryFn: () => get({ data: { propertyId } }),
  });

  const saveMut = useMutation({
    mutationFn: (poly: PolygonGeoJSON | null) =>
      save({ data: { propertyId, boundary: poly } }),
    onSuccess: (r) => {
      toast.success(
        r.area_sqm ? `Boundary saved · ${formatArea(r.area_sqm)}` : "Boundary cleared",
      );
      setJustSaved(true);
      qc.invalidateQueries({ queryKey: ["property-boundary", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const p: any = data?.property;
  const clientId: string | undefined = p?.client_id ?? p?.clients?.id;
  const clientName: string | undefined = p?.clients?.display_name;
  const addressLine = p
    ? [p.street, p.city, p.postal_code].filter(Boolean).join(", ")
    : "";
  const center =
    p?.latitude != null && p?.longitude != null
      ? { lat: Number(p.latitude), lng: Number(p.longitude) }
      : null;

  const backTarget = clientId
    ? { to: "/clients/$clientId" as const, params: { clientId } }
    : { to: "/clients" as const };

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          {clientId ? (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/clients/$clientId" params={{ clientId }}>
                <ArrowLeft className="mr-1 h-3.5 w-3.5 shrink-0" />
                Back to {clientName ?? "client"}
              </Link>
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => nav({ to: "/clients" })}>
              <ArrowLeft className="mr-1 h-3.5 w-3.5 shrink-0" /> Back
            </Button>
          )}
          <h1 className="mt-1 truncate text-2xl font-semibold">
            {clientName ? `${clientName}: property boundary` : "Property boundary"}
          </h1>
          {p && (
            <p className="text-sm text-muted-foreground">
              {addressLine || "No address on file"}
              {/* BUG-4: rendered the raw enum ("xlarge yard"). */}
              {p.yard_size
                ? ` · ${YARD_SIZE_LABELS[p.yard_size as YardSizeCategory] ?? humanizeEnum(p.yard_size)} yard`
                : ""}
              {p.boundary_area_sqm != null && ` · ${formatArea(Number(p.boundary_area_sqm))} saved`}
            </p>
          )}
        </div>
        {justSaved && clientId && (
          <Button asChild>
            <Link to="/clients/$clientId" params={{ clientId }}>
              <CheckCircle2 className="mr-1.5 h-4 w-4 shrink-0" />
              Done, back to {clientName ?? "client"}
            </Link>
          </Button>
        )}
      </div>

      {isLoading ? (
        <Card className="flex items-center justify-center p-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin shrink-0" />
        </Card>
      ) : !center ? (
        <Card className="p-6 text-sm">
          This property doesn't have coordinates yet. Add or geocode the address first, then come
          back to sketch the boundary.
          <div className="mt-3">
            <Link {...backTarget} className="text-primary underline">
              Back to {clientName ?? "client"}
            </Link>
          </div>
        </Card>
      ) : (
        <Card className="p-3">
          <BoundarySketch
            center={center}
            initial={(p?.boundary as PolygonGeoJSON) ?? null}
            areaSqm={p?.boundary_area_sqm != null ? Number(p.boundary_area_sqm) : null}
            saving={saveMut.isPending}
            onSave={(poly) => saveMut.mutate(poly)}
            height={520}
          />
        </Card>
      )}
    </>
  );
}
