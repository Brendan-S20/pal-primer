import { createFileRoute } from "@tanstack/react-router";

// POST /api/public/hooks/live-activity-action
//
// Start, pressed on the route's Live Activity on a locked iPhone. iOS runs
// the button's App Intent in the app's process in the background
// (ios/App/App/LiveActivity/RouteActivityIntents.swift), and the intent posts
// here with the ACTION TOKEN the signed-in app minted when the route went on
// the lock screen:
//
//   Authorization: Bearer <43-character token>
//   { "visitId": "<uuid>", "action": "start" }
//
// No Supabase session is involved, and none ever leaves the app. The token is
// good for one tech, one business, one route day, and Start only; the rules
// and the order they are applied in are src/lib/live-activity-action.ts and
// live-activity-action.server.ts. The transition is start_visit's own body
// (start_visit_as), as the token's tech.
//
// 200 { ok, outcome: "started" | "already", state } on success, where
// `state` is the content state the intent puts on the card at once. Anything
// else, and the intent opens the app on the stop instead. Never cached.

const MAX_BODY = 2_000;

export const Route = createFileRoute("/api/public/hooks/live-activity-action")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const token = /^Bearer ([A-Za-z0-9_-]{1,100})$/.exec(auth)?.[1];
        let body: { visitId?: unknown; action?: unknown } = {};
        try {
          const text = await request.text();
          if (text.length > MAX_BODY) return json({ ok: false, error: "bad_request" }, 413);
          body = text ? JSON.parse(text) : {};
        } catch {
          return json({ ok: false, error: "bad_request" }, 400);
        }
        const { performLiveActivityAction, liveActivityActionDeps } =
          await import("@/lib/live-activity-action.server");
        const reply = await performLiveActivityAction(
          { token, visitId: body?.visitId, action: body?.action },
          await liveActivityActionDeps(),
        );
        return json(reply.body, reply.status);
      },
    },
  },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
