import { Button } from "@/components/ui/button";
import { SetupStepPrimary } from "@/components/SetupStepFooter";
import { businessSaveBlocked, type DispatchRead } from "@/lib/setup-workday";

// ── /setup step 1's Save, and why it waits (#797 review) ──────────────────
//
// Step 1 shows the workday prefilled with what is stored. Until the stored
// hours have been read, the fields show the 08:00-17:00 fallback, and a Save
// pressed then would write that over hours the owner set in Settings,
// Scheduling. So Save waits for the read.
//
// A read that FAILED does not hold the step hostage: Save comes back, and
// the save itself writes only an hour the owner typed (workdayWrite in the
// setup route), so the fallback still cannot reach the database.
//
// Drawn in /setup's sticky bar (SetupStepPrimary, #771), where the bar can
// never be drawn over it; `form` keeps it the submit of step 1's form.
//
// Office-only (owner, office manager), so English.

/** Step 1's form id, which the button submits from inside the bar. */
export const SETUP_BUSINESS_FORM_ID = "setup-business";

export function BusinessSaveButton({
  saving,
  dispatch,
}: {
  saving: boolean;
  dispatch: DispatchRead;
}) {
  const loadingHours = !saving && !(dispatch.isSuccess || dispatch.isError);
  return (
    <SetupStepPrimary>
      <Button
        type="submit"
        form={SETUP_BUSINESS_FORM_ID}
        disabled={businessSaveBlocked(saving, dispatch)}
        data-setup-action="save"
      >
        {saving ? "Saving…" : loadingHours ? "Loading your hours…" : "Save and continue"}
      </Button>
    </SetupStepPrimary>
  );
}
