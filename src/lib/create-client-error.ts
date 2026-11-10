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

export function createFailedMessage(err: unknown, reason?: string): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (err == null || NO_ANSWER.test(raw)) {
    return "Create client did not finish: the server did not answer. Check Clients for this client before trying again, in case it was saved.";
  }
  return `Create client did not finish. ${reason ?? raw}`.trim();
}
