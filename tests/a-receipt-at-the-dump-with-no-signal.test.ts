// A receipt at the dump, with no signal.
//
// A tech logs a disposal fee from My Day with a photo of the ticket, standing
// somewhere with one bar or none. What has to be true:
//
//   * the expense AND its receipt go into the offline queue -- the photo in
//     the same IndexedDB photo store a completion photo uses, the action
//     pointing at it -- rather than the amount alone, or nothing;
//   * the id is minted once, so the online attempt and the replay are the same
//     row and the same receipt object, never two;
//   * on replay the receipt is uploaded to the org's folder in the private
//     expense-receipts bucket, the expense is recorded pointing at exactly that
//     object, and only THEN is the local copy deleted;
//   * a refusal from the server is shown, not queued;
//   * if the photo bytes are gone from the device, the amount is still logged;
//   * giving up on a queued expense frees its photo, and signing out drops it.
//
// Driven through the real logExpenseOrQueue and syncQueue with the IndexedDB
// queue and the storage client replaced, so what is asserted is what the code
// hands them.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SyncCallers } from "@/lib/offline/sync";

type Queued = { id: string } & Record<string, any>;

const store = {
  photos: new Map<string, { id: string; blob: Blob; contentType: string; ext: string }>(),
  actions: [] as Queued[],
  deletedPhotos: [] as string[],
};
const uploads: Array<{ bucket: string; path: string; body: unknown; opts: any }> = [];
let uploadError: Error | null = null;

vi.mock("@/lib/offline/queue", () => ({
  storePhoto: vi.fn(async (blob: Blob, contentType: string, ext: string) => {
    const id = `photo-${store.photos.size + 1}`;
    store.photos.set(id, { id, blob, contentType, ext });
    return id;
  }),
  enqueueAction: vi.fn(async (a: Record<string, unknown>) => {
    const id = `act-${store.actions.length + 1}`;
    store.actions.push({ ...a, id, ts: Date.parse("2026-09-29T15:10:00Z") } as Queued);
    return id;
  }),
  listPending: vi.fn(async (userId: string) => store.actions.filter((a) => a.userId === userId)),
  deleteAction: vi.fn(async (id: string) => {
    store.actions = store.actions.filter((a) => a.id !== id);
  }),
  recordAttempt: vi.fn(async () => 1),
  getPhoto: vi.fn(async (id: string) => store.photos.get(id)),
  deletePhoto: vi.fn(async (id: string) => {
    store.deletedPhotos.push(id);
    store.photos.delete(id);
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: {
      from: (bucket: string) => ({
        upload: vi.fn(async (path: string, body: unknown, opts: any) => {
          uploads.push({ bucket, path, body, opts });
          return { error: uploadError };
        }),
      }),
    },
  },
}));

vi.mock("@/lib/offline/action-owner", () => ({
  resolveOfflineUserId: vi.fn(async () => "tech-user-1"),
}));

vi.mock("@/lib/offline/connectivity", () => ({
  isDefinitelyOffline: () => false,
}));

const ORG = "0a000000-0000-4000-8000-0000000000aa";
const STAFF = "5a000000-0000-4000-8000-0000000000a1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const receiptFile = () =>
  new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], "dump-ticket.jpg", {
    type: "image/jpeg",
  });

const disposal = {
  spentOn: "2026-09-29",
  category: "disposal",
  amountCents: 4250,
  vendor: "County transfer station",
};

function fakeCallers(expenseImpl: (a: any) => Promise<void> = async () => {}) {
  const callers = {
    startVisit: vi.fn(async () => {}),
    completeVisit: vi.fn(async () => {}),
    skipVisit: vi.fn(async () => {}),
    recordVisitPhoto: vi.fn(async () => {}),
    logStationService: vi.fn(async () => {}),
    clockIn: vi.fn(async () => {}),
    clockOut: vi.fn(async () => {}),
    createExpense: vi.fn(expenseImpl),
  };
  return { callers, as: callers as unknown as SyncCallers };
}

beforeEach(() => {
  store.photos.clear();
  store.actions = [];
  store.deletedPhotos = [];
  uploads.length = 0;
  uploadError = null;
});

describe("logged with no signal, the expense is queued with its receipt", () => {
  it("stores the receipt in the photo store and points the queued action at it", async () => {
    const { logExpenseOrQueue } = await import("@/lib/offline/expense-actions");
    const send = vi.fn(async () => {});
    const res = await logExpenseOrQueue({
      organizationId: ORG,
      staffId: STAFF,
      fields: disposal,
      receipt: receiptFile(),
      send,
      online: false,
    });

    expect(res.queued).toBe(true);
    expect(send, "offline, nothing is sent").not.toHaveBeenCalled();
    expect(store.actions).toHaveLength(1);
    const a = store.actions[0];
    expect(a).toMatchObject({
      kind: "expense",
      organizationId: ORG,
      staffId: STAFF,
      fields: disposal,
      userId: "tech-user-1",
    });
    expect(a.expenseId).toMatch(UUID);
    expect(a.expenseId).toBe(res.expenseId);
    // The receipt: in the store, and the action names it.
    expect(a.photoId, "the queued expense does not carry its receipt").toBeTruthy();
    const photo = store.photos.get(a.photoId);
    expect(photo?.ext).toBe("jpg");
    expect(photo?.contentType).toBe("image/jpeg");
    expect((photo?.blob as File).name).toBe("dump-ticket.jpg");
  });

  it("queues an expense with no receipt without inventing one", async () => {
    const { logExpenseOrQueue } = await import("@/lib/offline/expense-actions");
    await logExpenseOrQueue({
      organizationId: ORG,
      staffId: STAFF,
      fields: { spentOn: "2026-09-29", category: "mileage", miles: 23.4 },
      receipt: null,
      send: vi.fn(),
      online: false,
    });
    expect(store.actions[0].photoId).toBeUndefined();
    expect(store.photos.size).toBe(0);
    // A mileage expense travels as miles: the database prices it.
    expect(store.actions[0].fields).toEqual({
      spentOn: "2026-09-29",
      category: "mileage",
      miles: 23.4,
    });
  });

  it("queues a request that never answered, under the same id and object name", async () => {
    const { logExpenseOrQueue } = await import("@/lib/offline/expense-actions");
    // The receipt landed, then the record step died on the network.
    const send = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const res = await logExpenseOrQueue({
      organizationId: ORG,
      staffId: STAFF,
      fields: disposal,
      receipt: receiptFile(),
      send,
    });
    expect(res.queued).toBe(true);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].bucket).toBe("expense-receipts");
    expect(uploads[0].path).toBe(`${ORG}/${STAFF}/${res.expenseId}.jpg`);
    expect(uploads[0].opts.upsert, "a retry must overwrite, not refuse").toBe(true);
    expect(store.actions[0].expenseId).toBe(res.expenseId);
  });

  it("shows a refusal instead of queueing it", async () => {
    const { logExpenseOrQueue } = await import("@/lib/offline/expense-actions");
    const send = vi.fn(async () => {
      throw new Error('new row violates row-level security policy for table "expenses"');
    });
    await expect(
      logExpenseOrQueue({
        organizationId: ORG,
        staffId: STAFF,
        fields: disposal,
        receipt: null,
        send,
      }),
    ).rejects.toThrow(/row-level security/);
    expect(store.actions).toHaveLength(0);
  });

  it("refuses to queue what it could not file", async () => {
    const { logExpenseOrQueue } = await import("@/lib/offline/expense-actions");
    await expect(
      logExpenseOrQueue({
        organizationId: ORG,
        staffId: null,
        fields: disposal,
        receipt: receiptFile(),
        send: vi.fn(),
        online: false,
      }),
    ).rejects.toThrow(/Open My Day once while online/);
    expect(store.actions).toHaveLength(0);
    expect(store.photos.size).toBe(0);
  });
});

describe("when signal returns, the replay files the receipt and then the expense", () => {
  async function queueOne(receipt: File | null = receiptFile()) {
    const { logExpenseOrQueue } = await import("@/lib/offline/expense-actions");
    return logExpenseOrQueue({
      organizationId: ORG,
      staffId: STAFF,
      fields: disposal,
      receipt,
      send: vi.fn(),
      online: false,
    });
  }

  it("uploads the receipt, records the expense pointing at it, then frees the local copy", async () => {
    const { expenseId } = await queueOne();
    const photoId = store.actions[0].photoId;
    const order: string[] = [];
    const { callers, as } = fakeCallers(async () => {
      order.push(`record, photo still on device: ${store.photos.has(photoId)}`);
    });
    const { syncQueue } = await import("@/lib/offline/sync");

    const res = await syncQueue(as, "tech-user-1");

    expect(res.succeeded).toBe(1);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      bucket: "expense-receipts",
      path: `${ORG}/${STAFF}/${expenseId}.jpg`,
      opts: { contentType: "image/jpeg", upsert: true },
    });
    expect(callers.createExpense).toHaveBeenCalledTimes(1);
    expect(callers.createExpense.mock.calls[0][0]).toEqual({
      data: {
        id: expenseId,
        mine: true,
        fields: { ...disposal, receiptPath: `${ORG}/${STAFF}/${expenseId}.jpg` },
      },
    });
    expect(order).toEqual(["record, photo still on device: true"]);
    expect(store.deletedPhotos).toEqual([photoId]);
    expect(store.actions).toHaveLength(0);
  });

  it("keeps the receipt on the device when the record step fails", async () => {
    await queueOne();
    const photoId = store.actions[0].photoId;
    const { as } = fakeCallers(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { syncQueue } = await import("@/lib/offline/sync");
    const res = await syncQueue(as, "tech-user-1");
    expect(res.failed).toBe(1);
    expect(store.photos.has(photoId)).toBe(true);
    expect(store.actions).toHaveLength(1);
  });

  it("still logs the amount when the receipt's bytes are gone", async () => {
    const { expenseId } = await queueOne();
    store.photos.clear();
    const { callers, as } = fakeCallers();
    const { syncQueue } = await import("@/lib/offline/sync");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await syncQueue(as, "tech-user-1");
    spy.mockRestore();
    expect(res.succeeded).toBe(1);
    expect(uploads).toHaveLength(0);
    expect(callers.createExpense.mock.calls[0][0].data).toEqual({
      id: expenseId,
      mine: true,
      fields: disposal,
    });
  });

  it("drops the receipt with the rest of the user's queue on sign-out", () => {
    // clearQueueForUser is IndexedDB and is replaced above, so this reads the
    // source: the sweep asks photoIdOf, and photoIdOf knows both kinds.
    const src = readFileSync(join(import.meta.dirname, "../src/lib/offline/queue.ts"), "utf8");
    const clear = src.slice(src.indexOf("export async function clearQueueForUser"));
    expect(clear.slice(0, clear.indexOf("\n}\n"))).toMatch(
      /const photoId = photoIdOf\(a\);\s+if \(photoId\) await tx\.objectStore\("photos"\)\.delete\(photoId\);/,
    );
    const helper = src.slice(src.indexOf("export function photoIdOf"));
    expect(helper.slice(0, helper.indexOf("\n}\n"))).toMatch(
      /a\.kind === "photo" \|\| a\.kind === "expense"/,
    );
  });

  it("frees the receipt when it gives up on the expense", async () => {
    await queueOne();
    const photoId = store.actions[0].photoId;
    const queue = await import("@/lib/offline/queue");
    vi.mocked(queue.recordAttempt).mockResolvedValueOnce(5);
    const { as } = fakeCallers(async () => {
      throw new Error("The server said no");
    });
    const { syncQueue } = await import("@/lib/offline/sync");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await syncQueue(as, "tech-user-1");
    spy.mockRestore();
    expect(res.deadLettered).toBe(1);
    expect(store.deletedPhotos).toContain(photoId);
  });
});
