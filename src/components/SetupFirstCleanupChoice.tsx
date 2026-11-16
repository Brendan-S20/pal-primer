import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SetupFirstCleanup } from "@/lib/setup-pricing";

/**
 * "Required", beside a choice Setup's Save will not go past without (#946).
 * Drawn before Save, so the owner is not told about it only by a refusal.
 */
export function SetupRequiredMarker() {
  return (
    <span
      className="ms-2 inline-block rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
      data-setup-required
    >
      Required
    </span>
  );
}

/**
 * Setup step 2's first-cleanup choice: Off, or a flat price. Required, and
 * nothing is picked until the owner picks it, because either answer decides
 * what new clients pay (#881, #946). A business whose first cleanup is tiered
 * by when the yard was last cleaned sets that on Zones and is not asked.
 */
export function SetupFirstCleanupChoice({
  tiered,
  value,
  onChange,
  price,
  onPriceChange,
}: {
  tiered: boolean;
  value: SetupFirstCleanup | null;
  onChange: (v: SetupFirstCleanup) => void;
  price: string;
  onPriceChange: (v: string) => void;
}) {
  const unchosen = !tiered && !value;
  return (
    <fieldset
      className="space-y-1.5"
      data-setup-first-cleanup
      aria-describedby={unchosen ? "setup-first-cleanup-required" : undefined}
    >
      <legend className="text-sm font-medium">
        First cleanup
        {!tiered && <SetupRequiredMarker />}
      </legend>
      <p className="text-xs text-muted-foreground">
        What a new client pays once, for the first visit, when the yard has built up.
      </p>
      {tiered ? (
        <p className="pt-1 text-sm">
          Priced by when the yard was last cleaned, set on{" "}
          <Link to="/zones" className="underline">
            Zones
          </Link>
          .
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 pt-1.5">
            <Button
              id="setup-first-cleanup-off"
              type="button"
              size="sm"
              variant={value === "off" ? "default" : "outline"}
              aria-pressed={value === "off"}
              onClick={() => onChange("off")}
            >
              Off, no first-cleanup charge
            </Button>
            <Button
              id="setup-first-cleanup-flat"
              type="button"
              size="sm"
              variant={value === "flat" ? "default" : "outline"}
              aria-pressed={value === "flat"}
              onClick={() => onChange("flat")}
            >
              Charge a flat price
            </Button>
          </div>
          {unchosen && (
            <p
              id="setup-first-cleanup-required"
              className="text-xs text-muted-foreground"
              data-setup-first-cleanup-unchosen
            >
              Choose one. Nothing is picked for you, because it decides what new clients pay.
            </p>
          )}
          {value === "flat" && (
            <div className="space-y-1.5 pt-2">
              <Label htmlFor="setup-zone-first-cleanup">First cleanup price ($)</Label>
              <Input
                id="setup-zone-first-cleanup"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) => onPriceChange(e.target.value)}
              />
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}
