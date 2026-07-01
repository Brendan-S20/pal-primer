import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { reportLovableError } from "@/lib/lovable-error-reporting";

/**
 * Default error boundary used by the router for any route that doesn't set
 * its own errorComponent. Reports to Lovable and offers retry.
 */
export function RouteError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();

  useEffect(() => {
    console.error(error);
    reportLovableError(error, { boundary: "router_default_error" });
  }, [error]);

  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center justify-center px-4 py-16 text-center"
    >
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {error.message || "This page hit an unexpected error."}
      </p>
      <div className="mt-5 flex gap-2">
        <Button
          onClick={() => {
            router.invalidate();
            reset();
          }}
        >
          Try again
        </Button>
        <Button variant="outline" onClick={() => router.history.back()}>
          Go back
        </Button>
      </div>
    </div>
  );
}

export function RouteNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center px-4 py-16 text-center">
      <h1 className="text-lg font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        We couldn't find what you were looking for.
      </p>
    </div>
  );
}
