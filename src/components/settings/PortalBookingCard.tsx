// Settings -> Client portal: extra cleanups customers ask for.
//
// Two answers. The price is what the office's "Book it" dialog starts from
// and what auto-accept books at; left blank, the office prices each request.
// Auto-accept is off by default and cannot be turned on without a price,
// because it books a visit with nobody looking and a visit needs a price.

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

export function PortalBookingCard() {
  const qc = useQueryClient();
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
      toast.success("Extra cleanup settings saved");
      qc.invalidateQueries({ queryKey: ["portal-booking-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!q.data?.canEdit) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Extra cleanups from the portal</CardTitle>
        <CardDescription>
          Clients can ask for a one-off cleanup on one of your working days, from tomorrow up to 30
          days out. It lands in Concerns for you to book or decline.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-xs">
          <Label htmlFor="one-off-price" className="text-xs">
            Price of an extra cleanup
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
          </p>
        </div>

        <div className="flex items-start justify-between gap-3 border-t pt-4">
          <div className="min-w-0 flex-1">
            <label htmlFor="one-off-auto" className="text-sm">
              Book requests automatically
            </label>
            <p className="text-xs text-muted-foreground">
              Off (default): you approve each one. On: a request is booked straight away at the
              price above, and you are told it happened. A client who books by text with the AI
              receptionist follows the same switch.
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
