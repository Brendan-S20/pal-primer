import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { stepSave } from "@/lib/setup-step-save";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { getOrgBranding } from "@/lib/org.functions";
import { listStaffAddresses, setStaffAddresses } from "@/lib/users.functions";
import { lookupAddressPoint } from "@/lib/geocode.functions";

// ── /setup, step 5, for a business that does not run pet waste ────────────
//
// The route planner ends a tech's day at their own end point, and only
// falls back to the business's dump site when there is none
// (staff_end_point). A dog walker, a sitter or a groomer has no dump site,
// but their day still ends somewhere: home, the shop, wherever the van
// parks. So the step asks that, and saves the answer as the end point of
// everybody who runs routes and does not have one yet, which is what
// getOnboardingStatus counts as done. Nobody's chosen end point is
// overwritten; a different one per person is set in Users & roles.
//
// Office-only (owner, office manager), so English. The pet-waste version of
// the step, the dump site, is DumpSitePanel in the setup route itself.

type StaffEnd = {
  id: string;
  display_name: string | null;
  active: boolean | null;
  is_field_tech: boolean | null;
  end_latitude: number | null;
};

export function DayEndPanel({ done, onSaved }: { done: boolean; onSaved: () => void }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listStaffAddresses);
  const saveFn = useServerFn(setStaffAddresses);
  const pointFn = useServerFn(lookupAddressPoint);
  const brandingFn = useServerFn(getOrgBranding);
  const staffQ = useQuery({ queryKey: ["staff-addresses"], queryFn: () => listFn() });
  const brandingQ = useQuery({ queryKey: ["org-branding"], queryFn: () => brandingFn() });
  const [address, setAddress] = useState("");
  // The provider's own coordinates for a picked suggestion, so saving does
  // not geocode the same address twice. Cleared when the text is edited.
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);

  const runners = ((staffQ.data?.staff ?? []) as StaffEnd[]).filter(
    (s) => s.active && s.is_field_tech,
  );
  // Nobody who already has an end point is overwritten: that was chosen.
  const open = runners.filter((s) => s.end_latitude == null);

  // One write per route-runner, in turn: a failure part-way leaves the
  // earlier ones saved, so stepSave refreshes the lists either way.
  const m = useMutation(
    stepSave({
      qc,
      save: async () => {
        let point = pin;
        if (!point) {
          const { geo } = await pointFn({ data: { query: address.trim() } });
          point = geo ? { lat: geo.latitude, lng: geo.longitude } : null;
        }
        // Done means the planner has an end it can use, so an address it
        // cannot place is not saved as one.
        if (!point)
          throw new Error("We could not find that address on the map. Check it and try again.");
        for (const s of open) {
          await saveFn({
            data: {
              staffId: s.id,
              endAddress: address.trim(),
              endLatitude: point.lat,
              endLongitude: point.lng,
            },
          });
        }
      },
      refresh: [["staff-addresses"], ["org-users"], ["staff"]],
      saved: "Saved. Routes end there now.",
      onSaved,
    }),
  );

  const usersLink = (
    <Link to="/settings/users" className="underline">
      Users &amp; roles
    </Link>
  );

  if (done) {
    return (
      <p className="text-sm">
        Routes end where each person's day ends. To change it, or to give somebody a different one,
        open {usersLink}.
      </p>
    );
  }

  if (staffQ.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (staffQ.isError) {
    return (
      <p className="text-sm">
        We could not load who runs routes. Each person's end of day can be set in {usersLink}.
      </p>
    );
  }

  if (open.length === 0) {
    return (
      <p className="text-sm">
        Nobody runs routes yet, so there is no day to end. Say who does in{" "}
        <Link to="/setup" search={{ step: "staff" }} className="underline">
          Who runs the route
        </Link>
        , then come back here.
      </p>
    );
  }

  const start = brandingQ.data?.contact_address;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (address.trim().length < 3) {
          toast.error("Add the address where the day ends.");
          return;
        }
        m.mutate();
      }}
    >
      <p className="text-sm">
        {start ? (
          <>
            Routes start at <bdi className="font-medium">{start}</bdi>.
          </>
        ) : (
          "Routes start at your business address once you add it in step 1."
        )}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="setup-day-end-address">Where the day ends</Label>
        <AddressAutocomplete
          id="setup-day-end-address"
          value={address}
          onChangeText={(t) => {
            setAddress(t);
            setPin(null);
          }}
          onResolved={(r) => {
            setAddress(r.address.formatted);
            setPin(
              r.address.latitude != null && r.address.longitude != null
                ? { lat: r.address.latitude, lng: r.address.longitude }
                : null,
            );
          }}
          placeholder="Home, the shop, wherever the van parks"
          maxLength={300}
        />
        <p className="text-xs text-muted-foreground">
          {open.length === 1 ? (
            <>
              Saved for <bdi>{open[0].display_name ?? "the person who runs routes"}</bdi>.
            </>
          ) : (
            <>Saved for the {open.length} people who run routes.</>
          )}{" "}
          Each person can have their own in {usersLink}.
        </p>
      </div>
      <Button type="submit" disabled={m.isPending} data-setup-action="save">
        {m.isPending ? "Saving…" : "Save and continue"}
      </Button>
    </form>
  );
}
