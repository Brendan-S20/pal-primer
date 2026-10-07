// A push names the thing it is about.
//
// "Item-specific notifications, like Uber": every update about one trip stacks
// under that trip, and a newer ETA replaces the old one rather than piling up
// beside it. Two keys do that, and each channel spells them differently:
//
//   threadId   grouping, nothing replaced   APNs aps.thread-id; FCM has no
//                                           field (Android groups by app), so
//                                           it rides in data; web has none
//   collapseId replace in place             APNs apns-collapse-id; FCM
//                                           android.collapse_key and
//                                           notification.tag; web `tag`
//
// The old single `tag` still works for the callers that send one, and a
// thread must never become a web tag, or a skip and a late arrival on the
// same tech's day would replace each other in a browser.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APNS_DEFAULT_TOPIC,
  apnsRequestFor,
  fcmMessageFor,
  pushCollapseKey,
  webPushBody,
} from "@/lib/push.server";

const ITEM = {
  title: "Taylor is running about 25 min late",
  body: "Pat, 12 Elm St. Arrival window ends 9:30 AM",
  url: "/my-day?date=2026-10-04&staff=s1&visit=v1",
  threadId: "route:5c000000-0000-4000-8000-000000000005:2026-10-04",
  collapseId: "late:f2000000-0000-4000-8000-0000000000a1",
  data: { type: "visit_late" },
};

describe("APNs", () => {
  it("groups by thread-id and replaces by apns-collapse-id, and keeps the deep link", () => {
    const req = apnsRequestFor("tok", ITEM, APNS_DEFAULT_TOPIC);
    expect(req.headers["apns-collapse-id"]).toBe(ITEM.collapseId);
    expect((req.body.aps as any)["thread-id"]).toBe(ITEM.threadId);
    expect(req.body.url).toBe(ITEM.url);
    expect(req.body.data).toEqual({ type: "visit_late" });
  });

  it("a thread with no collapse id groups and replaces nothing", () => {
    const req = apnsRequestFor("tok", { title: "t", threadId: "route:s:d" }, APNS_DEFAULT_TOPIC);
    expect(req.headers["apns-collapse-id"]).toBeUndefined();
    expect((req.body.aps as any)["thread-id"]).toBe("route:s:d");
  });

  it("the old tag still does both, and an explicit key wins over it", () => {
    const old = apnsRequestFor("tok", { title: "t", tag: "visit-1" }, APNS_DEFAULT_TOPIC);
    expect(old.headers["apns-collapse-id"]).toBe("visit-1");
    expect((old.body.aps as any)["thread-id"]).toBe("visit-1");
    const both = apnsRequestFor(
      "tok",
      { title: "t", tag: "visit-1", collapseId: "c", threadId: "th" },
      APNS_DEFAULT_TOPIC,
    );
    expect(both.headers["apns-collapse-id"]).toBe("c");
    expect((both.body.aps as any)["thread-id"]).toBe("th");
  });

  it("every key field-notify builds fits Apple's 64 bytes", () => {
    const uuid = "5c000000-0000-4000-8000-000000000005";
    for (const key of [
      `route:${uuid}:2026-10-04`,
      `late:${uuid}`,
      `access:${uuid}`,
      `finished:${uuid}:2026-10-04`,
      `collection:${uuid}`,
      `visit:${uuid}`,
    ]) {
      expect(new TextEncoder().encode(key).length, key).toBeLessThanOrEqual(64);
      expect(
        apnsRequestFor("tok", { title: "t", collapseId: key }, APNS_DEFAULT_TOPIC).headers[
          "apns-collapse-id"
        ],
      ).toBe(key);
    }
  });
});

describe("FCM", () => {
  it("replaces by tag and collapse_key, and carries the thread in data", () => {
    const m = fcmMessageFor("tok", ITEM);
    expect(m.message.android.notification.tag).toBe(ITEM.collapseId);
    expect(m.message.android.collapse_key).toBe(ITEM.collapseId);
    expect(m.message.data).toMatchObject({
      url: ITEM.url,
      threadId: ITEM.threadId,
      type: "visit_late",
    });
  });

  it("sends no collapse_key when there is nothing to collapse", () => {
    const m = fcmMessageFor("tok", { title: "t", threadId: "th" });
    expect(m.message.android).toEqual({ notification: {} });
  });
});

describe("web push", () => {
  it("the Notification tag is the collapse key, never the thread", () => {
    const body = JSON.parse(webPushBody(ITEM));
    expect(body.tag).toBe(ITEM.collapseId);
    expect(body.data).toEqual({ type: "visit_late", threadId: ITEM.threadId });
    expect(body).not.toHaveProperty("threadId");
    expect(body).not.toHaveProperty("collapseId");
    expect(body.url).toBe(ITEM.url);
    const threadOnly = JSON.parse(webPushBody({ title: "t", threadId: "th" }));
    expect(threadOnly).not.toHaveProperty("tag");
  });

  it("the old tag still reaches the browser as it did", () => {
    expect(JSON.parse(webPushBody({ title: "t", tag: "visit-1" })).tag).toBe("visit-1");
    expect(pushCollapseKey({ title: "t" })).toBeUndefined();
  });

  it("a tap opens the stop in the window already open, query string and all", () => {
    // It compared the window's PATH with the whole url, so a link with a
    // query string never matched and every tap opened a second window.
    const sw = readFileSync(join(import.meta.dirname, "../public/push-handlers.js"), "utf8");
    const click = sw.slice(sw.indexOf('addEventListener("notificationclick"'));
    expect(click).toMatch(/\.navigate\(target\.href\)/);
    expect(click).not.toMatch(/u\.pathname === url/);
    expect(click).toMatch(/target\.origin !== self\.location\.origin/);
  });
});
