// count_autopay_decline (migration 20261007140000), modelled on the fake's
// tables so a test driving the shipped webhook can watch the ladder move.
//
// The SQL is the owner of the count and the idempotency; this mirrors it rule
// for rule, and tests/sql/one-decline-counts-once.proof.sql proves the SQL
// itself against a real Postgres. Keep the two in step: a model that is kinder
// than the function proves nothing about production.

import type { Fake, Row } from "./fake-supabase";

export function modelCountAutopayDecline(fake: Fake): void {
  fake.onRpc("count_autopay_decline", (args) => {
    const client = (fake.tables.clients ?? []).find((c: Row) => c.id === args._client_id);
    if (!client) throw new Error(`count_autopay_decline: no client ${String(args._client_id)}`);
    const org = (fake.tables.organizations ?? []).find((o: Row) => o.id === client.organization_id);
    const threshold = Number(org?.dunning_pause_after_failures ?? 3);
    const counted = (client.autopay_counted_decline_pis as string[] | undefined) ?? [];
    const pi = (args._payment_intent_id as string | null) ?? null;

    if (pi !== null && counted.includes(pi)) {
      return [
        {
          counted: false,
          failure_count: Number(client.autopay_failure_count ?? 0),
          paused: client.autopay_paused === true,
          pause_after: threshold,
        },
      ];
    }
    const next = Number(client.autopay_failure_count ?? 0) + 1;
    Object.assign(client, {
      autopay_failure_count: next,
      autopay_paused: client.autopay_paused === true || next >= threshold,
      autopay_last_error: (args._error as string | null) ?? "Card charge failed",
      autopay_last_attempt_at: new Date().toISOString(),
      autopay_counted_decline_pis: pi === null ? counted : [...counted, pi].slice(-50),
    });
    return [
      {
        counted: true,
        failure_count: next,
        paused: client.autopay_paused === true,
        pause_after: threshold,
      },
    ];
  });
}
