import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";
import { fetchFromNativeApiOrigin, hasNativeApiOrigin } from "./lib/server-fn-origin";

const errorMiddleware = createMiddleware().server(async ({ next, request }) => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/email/")) {
    return next();
  }
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth],
  requestMiddleware: [errorMiddleware],
  // BUILD-9: only present in a bundled native build, where the baked-in
  // "/_serverFn/..." path would resolve to the app bundle instead of the API.
  // See src/lib/server-fn-origin.ts. Absent — and dead-code-eliminated — on web.
  ...(hasNativeApiOrigin ? { serverFns: { fetch: fetchFromNativeApiOrigin } } : {}),
}));
