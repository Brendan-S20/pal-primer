/** A conversation waits on the office when the newest message in it is the
 *  client's: listMessageThreads returns each client's newest message, so an
 *  inbound one is a text nobody has answered yet. Used by /inbox. */
export function threadsAwaitingReply<T extends { direction: string }>(threads: readonly T[]): T[] {
  return threads.filter((t) => t.direction === "inbound");
}
