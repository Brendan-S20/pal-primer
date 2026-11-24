import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * #968: "Do you have an EIN from the IRS?" at the top of Settings → Texting.
 *
 * Yes is today's filing, unchanged. No files a toll-free SOLE_PROPRIETOR
 * verification with no registration number, in the owner's own name: the EIN
 * field goes away, the business type is fixed to sole proprietor, and the
 * legal name is the authorized contact's first and last name.
 *
 * An LLC always has an EIN (Twilio: "all US LLCs have an EIN and are
 * therefore ineligible" for sole proprietor registration), so No says so,
 * and an owner who had picked LLC, corporation, partnership or nonprofit is
 * told to go back to Yes rather than having their choice changed silently.
 *
 * Two real radio buttons, each label the full 44px on touch.
 */
export function TextingEinQuestion({
  hasEin,
  onChange,
  pickedEntity,
  onPickedByMistake,
}: {
  hasEin: boolean;
  onChange: (hasEin: boolean) => void;
  /** The business type chosen before No, when it was not sole proprietor. */
  pickedEntity: string | null;
  /** #968 review: "I picked that by mistake": the owner is a sole proprietor
   *  after all, which clears the block. */
  onPickedByMistake?: () => void;
}) {
  const option = (value: boolean, label: string) => (
    <label className="flex min-h-10 min-w-0 cursor-pointer items-center gap-2 rounded-md border bg-background px-3 text-sm touch:min-h-11 has-[:checked]:border-primary">
      <input
        type="radio"
        name="has_ein"
        className="h-4 w-4 shrink-0"
        checked={hasEin === value}
        onChange={() => onChange(value)}
      />
      <span className="min-w-0">{label}</span>
    </label>
  );
  return (
    <fieldset
      className="space-y-3 rounded-lg border bg-card p-4"
      data-testid="texting-ein-question"
    >
      <legend className="px-1 text-sm font-medium">Do you have an EIN from the IRS?</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {option(true, "Yes, the business has an EIN")}
        {option(false, "No, I'm a sole proprietor without one")}
      </div>
      {hasEin ? (
        <p className="text-xs text-muted-foreground">
          An EIN is the nine-digit number on your IRS letter (CP 575 or 147C). Every LLC,
          corporation and partnership has one.
        </p>
      ) : (
        <div className="space-y-2 text-xs text-muted-foreground" data-testid="texting-no-ein">
          <p>
            Without an EIN, carriers register your texting number to you as a sole proprietor, in
            your own first and last name, taken from Authorized contact below. Your trading name
            goes under Doing business as, and every text still starts with it.
          </p>
          <p className="font-medium text-foreground">
            An LLC always has an EIN, even with no employees. If your business is an LLC,
            corporation or partnership, choose Yes and enter the number from your IRS letter.
          </p>
          {pickedEntity && (
            // #968 review: a block, not advice. Submit stays off and the
            // server refuses it until the owner chooses Yes or says the type
            // was a mistake: Twilio rejects an LLC filed as a sole proprietor
            // (30915), and the filing would then be locked to the no-EIN path.
            <div
              className="space-y-2 rounded-md border border-destructive/40 p-3"
              role="alert"
              data-testid="texting-no-ein-entity-block"
            >
              <p className="flex items-start gap-1.5 text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0">
                  You chose {pickedEntity} as your business type. That kind of business has an EIN,
                  so it cannot be filed without one: choose Yes and enter the number from your IRS
                  letter.
                </span>
              </p>
              {onPickedByMistake && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto min-h-9 whitespace-normal text-start touch:min-h-11"
                  onClick={onPickedByMistake}
                >
                  I picked {pickedEntity} by mistake. I&apos;m a sole proprietor
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}
