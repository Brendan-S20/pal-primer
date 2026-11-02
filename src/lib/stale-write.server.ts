import { sameInstant, staleWriteMessage, type StaleRecordKind } from "@/lib/stale-write";

const TABLE: Record<StaleRecordKind, "clients" | "visits" | "invoices"> = {
  client: "clients",
  visit: "visits",
  invoice: "invoices",
};

/**
 * Refuse a save made from a screen that loaded the row before somebody else
 * changed it (#655). `expectedUpdatedAt` is the `updated_at` the screen read.
 *
 * Absent means an older build that does not send it yet: the save goes ahead
 * as it always did, rather than every open tab failing at once on deploy.
 *
 * Read with the caller's client, so the row is the one their policies let
 * them see. A row they cannot see is left for the write itself to refuse.
 *
 * Where the write is a plain update, the caller also puts
 * `.eq("updated_at", expectedUpdatedAt)` on it, which closes the gap between
 * this read and the write. Where the write is an RPC this read is the check,
 * and the gap is the few milliseconds between them rather than the minutes a
 * form sits open.
 */
export async function refuseStaleWrite(
  supabase: any,
  kind: StaleRecordKind,
  id: string,
  expectedUpdatedAt: string | null | undefined,
): Promise<void> {
  if (expectedUpdatedAt === undefined) return;
  const { data, error } = await supabase
    .from(TABLE[kind])
    .select("updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return;
  if (!sameInstant(data.updated_at ?? null, expectedUpdatedAt)) {
    throw new Error(staleWriteMessage(kind));
  }
}
