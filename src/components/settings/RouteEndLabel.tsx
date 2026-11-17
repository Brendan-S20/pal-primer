import { useServiceLines } from "@/components/CommercialOnly";
import { ROUTE_END_BLANK_HINT } from "@/lib/route-endpoints";

/** The Route end field's label wherever a route end is entered (Settings →
 *  Users, the board's routing dialog). A dump site is a pet-waste route's end
 *  (#768), so a business that walks, sits, grooms or trains is not told about
 *  one. Until the lines are known the fail-open is pet waste, as everywhere
 *  else. */
export function RouteEndLabelText() {
  const { petWaste } = useServiceLines();
  return <>{petWaste ? "Route end (dump, home, shop)" : "Route end (home or shop)"}</>;
}

/** The Route end box's placeholder. A business that scoops keeps the one it
 *  had (`petWastePlaceholder`); any other is told what an EMPTY box does,
 *  which for a business with no dump site is end at the last visit
 *  (ROUTE_END_BLANK_HINT). */
export function useRouteEndPlaceholder(petWastePlaceholder: string): string {
  const { petWaste } = useServiceLines();
  return petWaste ? petWastePlaceholder : ROUTE_END_BLANK_HINT;
}
