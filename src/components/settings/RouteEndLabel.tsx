import { useServiceLines } from "@/components/CommercialOnly";

/** The Route end field's label on Settings → Users. A dump site is a
 *  pet-waste route's end (#768), so a business that walks, sits, grooms or
 *  trains is not told about one. Until the lines are known the fail-open is
 *  pet waste, as everywhere else. Its own component so the page does not
 *  take a hook for one label. */
export function RouteEndLabelText() {
  const { petWaste } = useServiceLines();
  return <>{petWaste ? "Route end (dump, home, shop)" : "Route end (home, shop)"}</>;
}
