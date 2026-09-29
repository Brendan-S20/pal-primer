// Everything a customer sees, in one place.
//
// The portal address and the portal's branding and policy used to live under
// Preferences, alongside Language, Time zone and Demo data. Eight cards on one
// page, 3,961px of it on a phone, under a heading that described about half of
// them.
//
// These two are the clearest case of the owner's own rule, stated about
// Profile and applying in both directions: a preference belongs under
// Preferences, and a thing that is not one does not. A sign-in address a
// CUSTOMER types and a brand colour a CUSTOMER sees belong with the rest of
// the customer-facing settings.
import { createFileRoute } from "@tanstack/react-router";
import { BrandingCard, PortalAddressCard } from "@/components/settings/ClientPortalCards";
import { PortalBookingCard } from "@/components/settings/PortalBookingCard";

export const Route = createFileRoute("/_authenticated/settings/client-portal")({
  component: ClientPortalSettings,
});

function ClientPortalSettings() {
  return (
    <div className="space-y-4">
      <PortalAddressCard />
      <BrandingCard />
      <PortalBookingCard />
    </div>
  );
}
