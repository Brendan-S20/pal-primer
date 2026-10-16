import { addonPurchasable } from "@/lib/addon-launch";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getClientTextingAvailability } from "@/lib/client-texting.functions";
import { CLIENT_TEXTING_DEFAULT } from "@/lib/client-texting";

/**
 * Whether this business can text its own clients. False until its own
 * texting number is provisioned, and false while the answer loads.
 * See lib/client-texting.ts.
 */
export function useClientTexting(): boolean {
  const fn = useServerFn(getClientTextingAvailability);
  const { data } = useQuery({
    queryKey: ["client-texting"],
    queryFn: () => fn(),
    staleTime: 5 * 60_000,
  });
  return addonPurchasable("managed-sms") && (data?.available ?? CLIENT_TEXTING_DEFAULT);
}
