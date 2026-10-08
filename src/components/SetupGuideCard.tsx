import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useMyRole } from "@/hooks/useMyRole";
import { SETUP_PATH, canRunSetup, openSetupGuide } from "@/lib/setup-guide";

/** The Knowledge Center's way back into the guided setup. Drawn only for the
 *  people the guide is for: a technician or a dispatcher cannot change the
 *  address, the price or the team, so a button that opened six steps they
 *  are refused would be a button that lies. */
export function SetupGuideCard() {
  const { role } = useMyRole();
  const navigate = useNavigate();
  if (!canRunSetup(role)) return null;
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">Setting up the business, or picking it back up?</p>
      <Button
        size="sm"
        variant="outline"
        className="mt-2 w-full"
        onClick={() => {
          openSetupGuide();
          void navigate({ to: SETUP_PATH });
        }}
      >
        Open the guided setup
      </Button>
    </div>
  );
}
