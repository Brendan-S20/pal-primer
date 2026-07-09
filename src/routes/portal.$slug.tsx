import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { portalResolveLegacy } from "@/lib/portal.functions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parent of both the generic company sign-in (/portal/{slug}) and the deep
// link (/portal/{slug}/{token}). A legacy bare link /portal/{uuid} lands here
// with a UUID-shaped first segment; we resolve its org slug and redirect to
// the canonical /portal/{slug}/{uuid}, so every already-issued link keeps
// working and no unbranded page is ever shown.
export const Route = createFileRoute("/portal/$slug")({
  beforeLoad: async ({ params }) => {
    if (UUID_RE.test(params.slug)) {
      const { slug } = await portalResolveLegacy({ data: { token: params.slug } });
      if (slug) {
        throw redirect({
          to: "/portal/$slug/$token",
          params: { slug, token: params.slug },
          replace: true,
        });
      }
      // Unknown/inactive token: fall through; the generic index will show a
      // "company not found" state rather than a hard error.
    }
  },
  component: () => <Outlet />,
});
