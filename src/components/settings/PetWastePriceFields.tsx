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
// one number.
//
// #860 (Brendan, 2026-11-10: "this should be a setting"): a pet-waste
// service now has a STANDARD PRICE of its own, edited here and nowhere else
// (services.base_price_cents + extra_pet_cents). A zone may override it, only
// inside that zone, from Settings → Zones & pricing. Every place that offers a
// plan price reads it through standard-price.ts.

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
export const STANDARD_PRICE_INPUT_ID = "service-standard-price";
export const STANDARD_EXTRA_DOG_INPUT_ID = "service-standard-extra-dog";
export const STANDARD_PRICE_LABEL = "Standard price per visit ($)";

/** What leaving the price blank does, everywhere it is read (#812 review,
 *  #860): the booking link falls back to the standard price or the zone's
 *  override (public_quote, one-time-cleanup.ts), so does the office's One-off
 *  dialog (booking-price.server.ts), and the portal cannot book an extra
 *  visit without someone looking (portal.functions.ts canAutoBook). */
export const ONE_TIME_BLANK_MEANS =
  "Left blank, your booking link and the office's one-off visits charge the standard price above (or a zone's own price inside that zone), and extra visits clients ask for wait for you to price and book them.";

export function PetWastePriceFields({
  standardPrice,
  extraDog,
  onStandardPriceChange,
  onExtraDogChange,
  zoneOverrides,
  oneTimePrice,
  savedOneTimeCents,
  loadError = null,
  onOneTimePriceChange,
}: {
  /** The standard price as typed (services.base_price_cents). */
  standardPrice: string;
  /** Each extra dog as typed (services.extra_pet_cents). */
  extraDog: string;
  onStandardPriceChange: (v: string) => void;
  onExtraDogChange: (v: string) => void;
  /** How many switched-on zones override the standard price; null unknown. */
  zoneOverrides: number | null;
  /** The field's text, or null when it cannot be edited here (the setting
   *  has not loaded, or the caller may not change it): the saved amount is
   *  shown instead, with a link to where it is set. */
  oneTimePrice: string | null;
  savedOneTimeCents: number | null;
  /** The one-time price could not be read: said, rather than "No price yet". */
  loadError?: string | null;
  onOneTimePriceChange: (v: string) => void;
}) {
  return (
    <div className="space-y-3 sm:col-span-2" id="service-price-note">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={STANDARD_PRICE_INPUT_ID}>{STANDARD_PRICE_LABEL}</Label>
          <Input
            id={STANDARD_PRICE_INPUT_ID}
            inputMode="decimal"
            placeholder="20.00"
            value={standardPrice}
            onChange={(e) => onStandardPriceChange(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={STANDARD_EXTRA_DOG_INPUT_ID}>Each extra dog, per visit ($)</Label>
          <Input
            id={STANDARD_EXTRA_DOG_INPUT_ID}
            inputMode="decimal"
            placeholder="0.00"
            value={extraDog}
            onChange={(e) => onExtraDogChange(e.target.value)}
          />
        </div>
        <p
          className="text-xs text-muted-foreground sm:col-span-2"
          data-testid="pet-waste-zone-price"
        >
          What a new plan, a one-off visit and your signup form charge.{" "}
          {zoneOverrides
            ? `${zoneOverrides} zone${zoneOverrides === 1 ? " has its" : "s have their"} own price, which applies only inside that zone.`
            : "A zone can set its own price, which applies only inside that zone."}{" "}
          Zone prices and the first-cleanup fee are in{" "}
          <Link to="/settings/zones" className="font-medium text-primary underline">
            Zones &amp; pricing
          </Link>
          . Changing this does not change the price of plans you already have.
        </p>
      </div>

      <div className="space-y-1.5">
        {oneTimePrice === null ? (
          <>
            <p className="text-sm font-medium">One-time cleanup</p>
            {loadError ? (
              <p className="text-sm text-destructive" data-testid="pet-waste-one-time-price">
                {loadError}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="pet-waste-one-time-price">
                {savedOneTimeCents === null
                  ? "No price yet."
                  : `${formatServiceMoney(savedOneTimeCents)} per cleanup.`}
              </p>
            )}
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
          , so changing it here changes it there. {ONE_TIME_BLANK_MEANS}
        </p>
      </div>
    </div>
  );
}
