// Provider registry: Google Places today; swap in Pelias here later
// without touching the UI or the server functions' shapes.
import type { AddressProvider } from "@/lib/address/provider.server";
import { googlePlacesProvider } from "@/lib/address/google-places.server";

export function getAddressProvider(): AddressProvider | null {
  if (googlePlacesProvider.isConfigured()) return googlePlacesProvider;
  return null;
}
