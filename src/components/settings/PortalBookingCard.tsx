// Settings -> Client portal: the extra visits clients ask for.
//
// Two answers. The price is what the office's "Book it" dialog starts from
// and what auto-accept books at; left blank, the office prices each request.
// Auto-accept is off by default and cannot be turned on without a price,
// because it books a visit with nobody looking and a visit needs a price.
//
// The price here is the pet-waste one-off's (the extra cleanup, priced by
// zone otherwise, so it needs a number of its own). A business that also
// walks, sits or grooms offers those from the same card at each service's
// own price (Settings -> Services), and the card says so to that business
// only; a pet-waste business reads the card it always has.

import { RECEPTIONIST_LAUNCHED } from "@/lib/receptionist-launch";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getPortalBookingSettings, setPortalBookingSettings } from "@/lib/portal-booking.functions";
import { useServiceLines } from "@/components/CommercialOnly";

export function PortalBookingCard() {
  const qc = useQueryClient();
  const { lines } = useServiceLines();
  const otherServices = lines.some((l) => l !== "pet_waste");
  const getFn = useServerFn(getPortalBookingSettings);
  const setFn = useServerFn(setPortalBookingSettings);
  const q = useQuery({ queryKey: ["portal-booking-settings"], queryFn: () => getFn() });
  const [price, setPrice] = useState("");
  const [autoAccept, setAutoAccept] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    setPrice(q.data.priceCents == null ? "" : (q.data.priceCents / 100).toFixed(2));
    setAutoAccept(q.data.autoAccept);
  }, [q.data]);

  const trimmed = price.trim();
  const priceCents = trimmed === "" ? null : Math.round(parseFloat(trimmed) * 100);
  const priceValid =
    priceCents === null ||
    (Number.isFinite(priceCents) && priceCents >= 0 && priceCents <= 1_000_000);

  const mut = useMutation({
    mutationFn: () => setFn({ data: { autoAccept: autoAccept && priceCents != null, priceCents } }),
    onSuccess: () => {
      toast.success("Extra visit settings saved");
      qc.invalidateQueries({ queryKey: ["portal-booking-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!q.data?.canEdit) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Extra visits from the portal</CardTitle>
        <CardDescription>
          Clients can ask for a one-off visit on one of your working days, from tomorrow up to 30
          days out. It lands in Concerns for you to book or decline.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-xs">
          <Label htmlFor="one-off-price" className="text-xs">
            {otherServices ? "Price of an extra pet waste visit" : "Price of an extra visit"}
          </Label>
          <Input
            id="one-off-price"
            className="mt-1"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            placeholder="Set it each time"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Shown to the client when they ask, and filled in when you book one. Leave it blank to
            price each request yourself.
            {otherServices &&
              " Your other services are offered at their own price from Settings → Services once their kind of service is bookable; one marked Coming soon, or with no price yet, is not offered."}
          </p>
        </div>

        <div className="flex items-start justify-between gap-3 border-t pt-4">
          <div className="min-w-0 flex-1">
            <label htmlFor="one-off-auto" className="text-sm">
              Book requests automatically
            </label>
            <p className="text-xs text-muted-foreground">
              Off (default): you approve each one. On: a request is booked straight away at the
              price above, and you are told it happened.
              {RECEPTIONIST_LAUNCHED &&
                " A client who books by text with the AI receptionist follows the same switch."}
              {priceCents == null && " Needs a price first."}
            </p>
          </div>
          <Switch
            id="one-off-auto"
            checked={autoAccept && priceCents != null}
            disabled={priceCents == null}
            onCheckedChange={setAutoAccept}
          />
        </div>

        <div className="flex justify-end">
          <Button disabled={!priceValid || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
