// The price part of the Services form for a pet-waste service (#788).
//
// A pet-waste service has no price of its own: a repeating plan is priced by
// its zone, and a one-time cleanup by the owner's extra-visit price
// (organizations.one_off_price_cents). Before #788 this spot said exactly
// that and offered no number and no field, so a new owner looking for where
// their $75 one-time cleanup goes found a sentence and two links.
//
// Now it shows both amounts and edits the one-time price right here. The
// field is the SAME setting as Settings → Client portal → Price of an extra
// visit (the form saves it through setPortalBookingSettings), so the booking
// link, quotes, the portal and the office's One-off dialog all keep reading
// one number. Plans stay priced by zone; this shows the lowest zone price
// and links to Zones & pricing, where the first-cleanup fee lives too.

import { Link } from "@tanstack/react-router";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ONE_OFF_PRICE_SETTING_HASH,
  ONE_OFF_PRICE_SETTING_PATH,
  ONE_TIME_CLEANUP_PRICE_LABEL,
  formatServiceMoney,
} from "@/lib/services";

export const ONE_TIME_PRICE_INPUT_ID = "service-one-time-price";

export function PetWastePriceFields({
  oneTimePrice,
  savedOneTimeCents,
  zoneFromCents,
  onOneTimePriceChange,
}: {
  /** The field's text, or null when it cannot be edited here (the setting
   *  has not loaded, or the caller may not change it): the saved amount is
   *  shown instead, with a link to where it is set. */
  oneTimePrice: string | null;
  savedOneTimeCents: number | null;
  /** lowestZoneVisitCents over the business's zones; null when none is priced. */
  zoneFromCents: number | null;
  onOneTimePriceChange: (v: string) => void;
}) {
  return (
    <div className="space-y-3 sm:col-span-2" id="service-price-note">
      <div className="space-y-1">
        <p className="text-sm font-medium">Repeating plans</p>
        <p className="text-sm text-muted-foreground" data-testid="pet-waste-zone-price">
          {zoneFromCents === null
            ? "Priced by zone. No zone has a price yet."
            : `Priced by zone, from ${formatServiceMoney(zoneFromCents)} per visit.`}{" "}
          Set zone prices and the first-cleanup fee in{" "}
          <Link to="/zones" className="font-medium text-primary underline">
            Zones &amp; pricing
          </Link>
          .
        </p>
      </div>

      <div className="space-y-1.5">
        {oneTimePrice === null ? (
          <>
            <p className="text-sm font-medium">One-time cleanup</p>
            <p className="text-sm text-muted-foreground" data-testid="pet-waste-one-time-price">
              {savedOneTimeCents === null
                ? "No price yet."
                : `${formatServiceMoney(savedOneTimeCents)} per cleanup.`}
            </p>
          </>
        ) : (
          <>
            <Label htmlFor={ONE_TIME_PRICE_INPUT_ID}>{ONE_TIME_CLEANUP_PRICE_LABEL}</Label>
            <Input
              id={ONE_TIME_PRICE_INPUT_ID}
              className="max-w-40"
              inputMode="decimal"
              placeholder="75.00"
              value={oneTimePrice}
              onChange={(e) => onOneTimePriceChange(e.target.value)}
            />
          </>
        )}
        <p className="text-xs text-muted-foreground">
          One visit sold on its own, on your booking link, on quotes and when a client asks for an
          extra visit. It is the same number as the Client portal&apos;s{" "}
          <Link
            to={ONE_OFF_PRICE_SETTING_PATH}
            hash={ONE_OFF_PRICE_SETTING_HASH}
            className="font-medium text-primary underline"
          >
            Price of an extra visit
          </Link>
          , so changing it here changes it there. Left blank, a one-time cleanup uses the
          zone&apos;s visit price.
        </p>
      </div>
    </div>
  );
}
