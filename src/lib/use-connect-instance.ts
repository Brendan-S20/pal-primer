import { useEffect, useRef, useState } from "react";

// One Stripe Connect instance per mount of the dashboard (#922).
//
// Every `loadConnectAndInitialize` is a fresh connect-js session: its own
// Account Session fetch, its own set of iframes from connect-js.stripe.com, and
// its own round of Stripe's internal permission queries to graphql.stripe.com.
// An instance that is created again while the first is still alive does all of
// that a second time, and the first is never told to stop — which on /payments
// shows up as the same console noise repeating. So:
//
//   - created at most once while it is alive. A re-run of the effect (a retry,
//     a dependency that changed, React StrictMode's dev double-invoke) reuses
//     it instead of initialising a second one.
//   - a Retry (reloadKey) only creates one if there is none, i.e. after a
//     failure. A live instance is not replaced by pressing Try again.
//   - logged out on unmount, so nothing of it outlives the page.
//
// `create` is passed in rather than written here so the route keeps the
// session call, the deadlines and the appearance where the tests that pin them
// already read them (payments-never-loads-forever, stripe-connect-follows-the-
// theme).

/** The two methods of a StripeConnectInstance this hook relies on. */
export type ConnectInstanceLike = {
  update?: (opts: unknown) => void;
  logout?: () => Promise<void> | void;
};

export function useConnectInstance<T extends ConnectInstanceLike>({
  enabled,
  reloadKey,
  create,
}: {
  /** False while nothing should load (not yet measured, or replaced on a
   *  narrow screen). Turning it false does not tear down a live instance. */
  enabled: boolean;
  /** Bumped by Try again. */
  reloadKey: number;
  create: () => Promise<T>;
}): { instance: T | null; error: string | null } {
  const [instance, setInstance] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<T | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const createRef = useRef(create);
  createRef.current = create;

  useEffect(() => {
    if (!enabled) return;
    if (live.current) {
      setInstance(live.current);
      return;
    }
    // One creation at a time. A second run while the first is still waiting
    // on Stripe (StrictMode, a quick Try again) joins it rather than racing it.
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    (async () => {
      try {
        const inst = await createRef.current();
        if (!mounted.current) {
          // The page went away while Stripe answered: nobody will render it.
          void inst?.logout?.();
          return;
        }
        live.current = inst;
        setInstance(inst);
      } catch (e) {
        if (mounted.current)
          setError((e as Error)?.message || "Couldn't load the payment dashboard");
      } finally {
        inFlight.current = false;
      }
    })();
  }, [enabled, reloadKey]);

  // Unmount only. Set back to true on (re)mount, because StrictMode runs this
  // cleanup and then mounts the same component again.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const inst = live.current;
      live.current = null;
      try {
        void inst?.logout?.();
      } catch {
        // Logging out is tidying up; a failure in it must not surface.
      }
    };
  }, []);

  return { instance, error };
}
