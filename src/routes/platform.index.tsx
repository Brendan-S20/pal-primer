import { createFileRoute, redirect } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";

export const Route = createFileRoute("/platform/")({
  beforeLoad: () => {
    throw redirect({ to: "/platform/overview" });
  },
  // QA-P2: was `() => null`, which is enough to stop the router erroring on a
  // match with no component but still leaves a blank page if it ever renders.
  // Same fallback as every other redirect stub now — it says something and
  // retries the navigation from the client.
  component: () => <RedirectFallback to="/platform/overview" label="the platform console" />,
});
