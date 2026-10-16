// Work that has to outlive the response it was started in.
//
// A Cloudflare Worker may stop running a request's leftover promises once the
// response has gone out. Anything still in flight then (an auto-routing run,
// a completion email that missed its deadline) is cut off with no error and
// no log, unless it was handed to the ExecutionContext's waitUntil first.

/** Hands a promise to the Worker so it is not cut off after the response. */
export type KeepAlive = (job: Promise<unknown>) => void;

/**
 * The Worker's waitUntil, if this request has one.
 *
 * On Cloudflare, Nitro puts the ExecutionContext's waitUntil on the incoming
 * Request (nitro's cloudflare `augmentReq`); monitoring/report.server.ts
 * relies on the same thing. Without it (Node in dev, vitest) this returns a
 * function that does nothing, and the caller's promise simply runs on, which
 * in Node it does after a disconnect anyway.
 */
export async function keepAliveForThisRequest(): Promise<KeepAlive> {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const request = getRequest() as
      (Request & { waitUntil?: (p: Promise<unknown>) => void }) | null;
    const waitUntil = request?.waitUntil;
    if (typeof waitUntil === "function") {
      return (job) => {
        try {
          waitUntil.call(request, job);
        } catch {
          /* the job still runs; only the extension was refused */
        }
      };
    }
  } catch {
    /* not inside a request: nothing to extend */
  }
  return () => {};
}
