// One answer to "who is calling?" per request, where a request asks it many
// times (#900).
//
// getShellParts runs a dozen loaders side by side, and each one that checks
// the caller (features, trial, the billing banner, the review count, the
// franchise context, texting) used to ask the database again: user_roles and
// access_turned_off(), two requests per loader, all for the same person in
// the same request. A cold /clients load spent twelve of its seventy database
// requests on that one question.
//
// The sharing is opt-in and per request. A handler calls
// shareCallerLookups(context.supabase) on the client the auth middleware made
// for THIS request; from then on the lookups made with that client share one
// answer. Nothing else is shared:
//
//   * The middleware creates a new client for every request, so the shared
//     answers live exactly as long as the request does (a WeakMap entry on
//     an object nobody holds after the response).
//   * A client nobody registered (the service-role client, a test double, any
//     handler that did not opt in) is not shared at all: every lookup reads,
//     exactly as before. The service-role client is one object for the whole
//     isolate, and sharing on it would carry one person's answer into another
//     request; that is why this is opt-in rather than keyed on whatever client
//     comes in.
//   * A lookup that fails is forgotten, so a later one in the same request
//     reads again rather than repeating the failure.
//
// Only reads belong here, and only in a handler that writes nothing that
// would change the answer (a role, a staff row) partway through.

const shared = new WeakMap<object, Map<string, Promise<unknown>>>();

/** Share the caller lookups made with `client` for the rest of this request. */
export function shareCallerLookups(client: unknown): void {
  if (client && typeof client === "object" && !shared.has(client)) shared.set(client, new Map());
}

/**
 * `read()`, or the answer an earlier identical lookup in this request already
 * got, when the client was registered with shareCallerLookups.
 */
export function sharedLookup<T>(client: unknown, key: string, read: () => PromiseLike<T>): Promise<T> {
  const answers = client && typeof client === "object" ? shared.get(client) : undefined;
  if (!answers) return Promise.resolve(read());
  const held = answers.get(key) as Promise<T> | undefined;
  if (held) return held;
  const answer = Promise.resolve(read());
  answers.set(key, answer);
  answer.catch(() => {
    if (answers.get(key) === answer) answers.delete(key);
  });
  return answer;
}
