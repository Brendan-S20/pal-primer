import { createFileRoute } from "@tanstack/react-router";
import { PortalGenericEntry } from "@/lib/portal-ui";

export const Route = createFileRoute("/portal/$slug/")({
  component: GenericEntryRoute,
});

function GenericEntryRoute() {
  const { slug } = Route.useParams();
  return <PortalGenericEntry slug={slug} />;
}
