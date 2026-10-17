// The "connected / last sync" line under a QuickBooks connection.
//
// `connected_at` is rewritten on every connect AND reconnect, while
// `last_sync_at` survives a reconnect. So after a reconnect the row can read
// "since Oct 12 · last sync Oct 3", a last sync before the connection started
// (QA row 41 / #433). Both values are true; the label was what made them
// contradict each other. This decides the wording from the order of the two.

export type QboTimeParts = {
  /** "Connected Oct 12, 9:14 AM", or null when there is no date. */
  connected: string | null;
  /** The sync half, worded so it never reads as earlier than `connected`. */
  sync: string | null;
};

export function qboConnectionParts(
  connectedAt: string | null | undefined,
  lastSyncAt: string | null | undefined,
  format: (iso: string) => string,
): QboTimeParts {
  const connected = connectedAt ? `Connected ${format(connectedAt)}` : null;
  if (!lastSyncAt) return { connected, sync: connectedAt ? "Not synced yet" : null };
  const syncedBeforeConnect =
    !!connectedAt && new Date(lastSyncAt).getTime() < new Date(connectedAt).getTime();
  return {
    connected,
    sync: syncedBeforeConnect
      ? `Not synced since reconnecting (last sync ${format(lastSyncAt)})`
      : `Last sync ${format(lastSyncAt)}`,
  };
}
