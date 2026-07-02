import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getPropertyBoundary, updatePropertyBoundary } from "@/lib/properties.functions";
import { BoundarySketch, formatArea, type PolygonGeoJSON } from "@/components/BoundarySketch";

export const Route = createFileRoute("/_authenticated/properties/$propertyId/boundary")({
  component: BoundaryPage,
});

function BoundaryPage() {
  const { propertyId } = Route.useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const get = useServerFn(getPropertyBoundary);
  const save = useServerFn(updatePropertyBoundary);

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
      qc.invalidateQueries({ queryKey: ["property-boundary", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const p: any = data?.property;
  const center =
    p?.latitude != null && p?.longitude != null
      ? { lat: Number(p.latitude), lng: Number(p.longitude) }
      : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" onClick={() => nav({ to: "/clients" })}>
            <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back
          </Button>
          <h1 className="mt-1 text-2xl font-semibold">Property boundary</h1>
          {p && (
            <p className="text-sm text-muted-foreground">
              {p.street}, {p.city} {p.postal_code}
              {p.yard_size ? ` · ${p.yard_size} yard` : ""}
              {p.boundary_area_sqm != null && ` · ${formatArea(Number(p.boundary_area_sqm))} saved`}
            </p>
          )}
        </div>
      </div>

      {isLoading ? (
        <Card className="flex items-center justify-center p-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </Card>
      ) : !center ? (
        <Card className="p-6 text-sm">
          This property doesn't have coordinates yet. Add or geocode the address first, then come
          back to sketch the boundary.
          <div className="mt-3">
            <Link to="/clients" className="text-primary underline">
              Back to clients
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
    </div>
  );
}
