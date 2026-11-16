// The sentence that stays under Create client when it did not finish (#784).
//
// Two cases read differently to the person who pressed it:
//
//   * the server answered no, with a reason (serverErrorMessage's words: a
//     plan that has run out, a refused role, a first visit in the past). The
//     server undoes a half-written client, so nothing was saved.
//   * the request never got an answer: the connection dropped, or the server
//     fell over mid-request ("Failed to fetch" in Chrome, "Load failed" in
//     Safari, "NetworkError ..." in Firefox). The server may or may not have
//     finished, so the person is told to look before pressing again, rather
//     than told it failed and invited to make a duplicate.
const NO_ANSWER = /failed to fetch|load failed|networkerror|network request failed|fetch failed/i;

// A third case, from #784's stale draft: the form itself threw before any
// request left the device. Chrome says "Cannot read properties of undefined
// (reading 'trim')", Safari "undefined is not an object", Firefox "can't
// access property". Shown raw, that names a JavaScript property to an owner
// adding a customer. Nothing was sent, so nothing was saved, and the way out
// that worked on the live app was Discard draft.
const THE_FORM_THREW =
  /cannot read propert|undefined is not an object|null is not an object|can't access property|is not a function/i;

export const FORM_THREW_MESSAGE =
  "Create client did not finish: something in this form could not be read, so nothing was saved. Press Discard draft at the top if it shows, or reload the page, and enter the client again.";

export function createFailedMessage(err: unknown, reason?: string): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (err == null || NO_ANSWER.test(raw)) {
    return "Create client did not finish: the server did not answer. Check Clients for this client before trying again, in case it was saved.";
  }
  if (err instanceof TypeError && THE_FORM_THREW.test(raw)) return FORM_THREW_MESSAGE;
  return `Create client did not finish. ${reason ?? raw}`.trim();
}
