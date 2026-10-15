// One button walks the visit.
//
// The owner, on 2026-10-09, on the build with #357 in it: "When I start a
// visit, it auto-opens the camera. It's not supposed to do that. And it
// created another button for taking a completion picture, instead of keeping
// all the same button and following a workflow."
//
// So each stop card has ONE primary button, and it advances in place:
// Start -> "Take completion photo" (only where the business requires one and
// the visit has none) -> Complete. The camera opens only on a tap at the
// photo step. src/lib/visit-step.ts is the rule; this file checks it three
// ways:
//
//   1. the rule itself, state by state;
//   2. what a tap at each step does, with the native camera
//      (src/lib/native) mocked, so "Start never opens the camera" and "the
//      photo step does" are asserted on the camera call itself;
//   3. the real My Day route, rendered to markup the way
//      my-day-in-arabic-reads-right-to-left renders it, with a stop at each
//      step: exactly one step button per card, carrying the step's label, and
//      nothing beside it doing the same job.
//
// No DOM library is installed in this repo (the My Day render tests use
// react-dom/server), so a click is a call to the same handlers the button's
// onClick calls, and "the same button" is pinned on the route's source: one
// element carries data-visit-step, and it is not inside a branch.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DAY = "2026-10-09";

// ── The camera ────────────────────────────────────────────────────────────
const camera = vi.hoisted(() => ({
  native: true,
  takePhotoNative: vi.fn<() => Promise<Blob | null>>(),
}));
vi.mock("@/lib/native", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    isNative: () => camera.native,
    takePhotoNative: camera.takePhotoNative,
  };
});

// ── The route's surroundings, as my-day-in-arabic-reads-right-to-left ────
vi.mock("@tanstack/react-start", () => ({
  useServerFn: (f: unknown) => f,
  createServerFn: () => {
    const chain: any = () => chain;
    chain.validator = () => chain;
    chain.inputValidator = () => chain;
    chain.middleware = () => chain;
    chain.handler = () => chain;
    return chain;
  },
  createMiddleware: () => {
    const chain: any = {};
    chain.server = () => chain;
    chain.client = () => chain;
    chain.middleware = () => chain;
    return chain;
  },
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    options: opts,
    useSearch: () => ({}),
    useNavigate: () => () => {},
  }),
  Link: ({ children, to, ...rest }: { children?: ReactNode; to?: string }) =>
    createElement("a", { href: to, ...rest }, children),
  useNavigate: () => () => {},
  useRouterState: () => ({ location: { pathname: "/my-day" } }),
}));
vi.mock("@/hooks/useOrgToday", () => ({
  useOrgToday: () => DAY,
  useOrgTimezone: () => "America/Chicago",
}));
vi.mock("@/hooks/useMyRole", () => ({
  useMyRole: () => ({ role: "tech", orgId: "org-1", loading: false }),
  usePermissions: () => ({ can: () => false }),
  canAccess: () => true,
}));
vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ docksFrom: "lg-mouse", isMobile: true, state: "expanded" }),
}));

import i18n from "@/lib/i18n";
import { Route } from "@/routes/_authenticated/my-day";
import {
  captureCompletionFile,
  runVisitStep,
  takeCompletionPhoto,
  visitStep,
  type VisitStepState,
} from "@/lib/visit-step";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

beforeEach(() => {
  camera.native = true;
  camera.takePhotoNative.mockReset();
});
afterAll(async () => {
  await i18n.changeLanguage("en");
});

// ── 1. The rule ───────────────────────────────────────────────────────────

const base: VisitStepState = {
  status: "scheduled",
  startedHere: false,
  requireCompletionPhoto: true,
  photoOnFile: false,
  noPhotoReasonGiven: false,
  canPerform: true,
};
const at = (over: Partial<VisitStepState>) => visitStep({ ...base, ...over });

describe("the step the button is at", () => {
  it("is Start on a stop not yet started", () => {
    expect(at({})).toBe("start");
    // A photo taken before Start does not skip Start: the button still walks
    // the visit in order, and Complete is the tap after it.
    expect(at({ photoOnFile: true })).toBe("start");
  });

  it("after Start, is the photo where the business requires one and there is none", () => {
    // Live (the refetch has landed) or queued (useQueuedLifecycle laid the
    // queued Start over the status): in_progress either way.
    expect(at({ status: "in_progress" })).toBe("photo");
    // The moment Start succeeds, before either has.
    expect(at({ startedHere: true })).toBe("photo");
    // Yesterday's stop, auto-marked missed, is still completable.
    expect(at({ status: "missed" })).toBe("photo");
  });

  it("after Start, is Complete where no photo is required", () => {
    expect(at({ startedHere: true, requireCompletionPhoto: false })).toBe("complete");
    expect(at({ status: "in_progress", requireCompletionPhoto: false })).toBe("complete");
  });

  it("after the photo (live or queued), or a reason there is none, is Complete", () => {
    expect(at({ status: "in_progress", photoOnFile: true })).toBe("complete");
    expect(at({ status: "in_progress", noPhotoReasonGiven: true })).toBe("complete");
  });

  it("is Complete, never the camera, for someone who cannot perform the visit", () => {
    expect(at({ status: "in_progress", canPerform: false })).toBe("complete");
  });

  it("is nothing on a finished card", () => {
    for (const status of ["completed", "skipped", "canceled"]) {
      expect(at({ status, startedHere: true })).toBeNull();
    }
  });
});

// ── 2. What a tap does ────────────────────────────────────────────────────

/** The handlers the card's button hands runVisitStep, with the real photo
 *  step (captureCompletionFile -> the native camera) behind "photo". */
function card() {
  const start = vi.fn(async () => ({ queued: false }));
  const complete = vi.fn(async () => ({ queued: false }));
  const upload = vi.fn(async (_f: File) => true);
  const pickFromWeb = vi.fn(async () => null as File | null);
  const handlers = {
    start,
    complete,
    photo: () => takeCompletionPhoto({ capture: () => captureCompletionFile(pickFromWeb), upload }),
  };
  return { handlers, start, complete, upload, pickFromWeb };
}

describe("a tap on the button", () => {
  it("at Start starts the visit and does not open the camera", async () => {
    const c = card();
    await runVisitStep("start", c.handlers);
    expect(c.start).toHaveBeenCalledTimes(1);
    expect(camera.takePhotoNative).not.toHaveBeenCalled();
    expect(c.pickFromWeb).not.toHaveBeenCalled();
    expect(c.complete).not.toHaveBeenCalled();
  });

  it("at the photo step opens the native camera and saves the completion photo, and does not complete", async () => {
    camera.takePhotoNative.mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
    const c = card();
    expect(await runVisitStep("photo", c.handlers)).toBe("taken");
    expect(camera.takePhotoNative).toHaveBeenCalledTimes(1);
    expect(c.upload).toHaveBeenCalledTimes(1);
    expect(c.upload.mock.calls[0][0]).toBeInstanceOf(File);
    // Complete is the button's NEXT tap, not this one's.
    expect(c.complete).not.toHaveBeenCalled();
    expect(c.start).not.toHaveBeenCalled();
  });

  it("at the photo step, a cancelled camera saves nothing and opens no second picker", async () => {
    camera.takePhotoNative.mockRejectedValue(new Error("User cancelled photos app"));
    const c = card();
    expect(await runVisitStep("photo", c.handlers)).toBe("cancelled");
    expect(c.upload).not.toHaveBeenCalled();
    expect(c.pickFromWeb).not.toHaveBeenCalled();
  });

  it("at the photo step in a browser, uses the card's file input", async () => {
    camera.native = false;
    const c = card();
    c.pickFromWeb.mockResolvedValue(new File(["x"], "p.jpg", { type: "image/jpeg" }));
    expect(await runVisitStep("photo", c.handlers)).toBe("taken");
    expect(c.pickFromWeb).toHaveBeenCalledTimes(1);
    expect(camera.takePhotoNative).not.toHaveBeenCalled();
  });

  it("at Complete completes, and nothing else", async () => {
    const c = card();
    await runVisitStep("complete", c.handlers);
    expect(c.complete).toHaveBeenCalledTimes(1);
    expect(c.start).not.toHaveBeenCalled();
    expect(camera.takePhotoNative).not.toHaveBeenCalled();
  });
});

describe("My Day wires the button to those steps, and to nothing else", () => {
  const myDay = read("src/routes/_authenticated/my-day.tsx");

  it("draws ONE step button, outside any branch on the step, so it is the same element at every step", () => {
    expect(myDay.match(/data-visit-step=/g)).toHaveLength(1);
    const el = myDay.slice(myDay.lastIndexOf("{step && (", myDay.indexOf("data-visit-step=")));
    expect(el.slice(0, el.indexOf("</Button>"))).toMatch(
      /^\{step && \(\s*<Button[\s\S]*data-visit-step=\{step\}[\s\S]*onClick=\{tapStep\}/,
    );
  });

  it("Start's success moves the button on and opens no camera", () => {
    const start = myDay.slice(myDay.indexOf("const start = useMutation({"));
    const onSuccess = start.slice(0, start.indexOf("onError")).replace(/\/\/.*$/gm, "");
    expect(onSuccess).toMatch(/setStartedHere\(true\)/);
    expect(onSuccess).not.toMatch(/capture|camera|takePhoto|Photo/i);
  });

  it("the photo step is the only caller of the completion camera", () => {
    expect(myDay.match(/captureCompletionFile\(/g)).toHaveLength(1);
    expect(myDay).toMatch(/photo: \(\) => \{\s*haptic\("tap"\);\s*return tapPhotoStep\(\);/);
    // Start and Complete go through the same offline-aware actions as ever
    // (useOfflineVisitActions: runOrQueue, then IndexedDB).
    expect(myDay).toMatch(/start: \(\) => start\.mutate\(\)/);
    expect(myDay).toMatch(/complete: \(\) => complete\.mutate\(\)/);
    expect(myDay).toMatch(/mutationFn: \(\) => actions\.start\(\)/);
    expect(myDay).toMatch(/const r = await actions\.uploadPhoto\(file, photoKind_\);/);
  });

  it("the lock screen lands on the button and asks the card for nothing", () => {
    expect(myDay).not.toMatch(/openCapture|captureRequest|captureAsk/);
  });

  it("the step reads the status as drawn, queued actions and all", () => {
    expect(myDay).toMatch(/withQueuedLifecycle\(serverVisits \?\? \[\], queuedLifecycle\)/);
    expect(myDay).toMatch(/status: visit\.status,\s*startedHere,/);
  });
});

// ── 3. The real page, a stop at each step ─────────────────────────────────

function visit(id: string, status: string, over: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: "org-1",
    assigned_staff_id: "s-1",
    sequence: Number(id.replace(/\D/g, "")),
    status,
    scheduled_on: DAY,
    eta_start: `${DAY}T14:15:00Z`,
    eta_end: `${DAY}T14:45:00Z`,
    earliest_time: null,
    latest_time: null,
    started_at: status === "in_progress" ? new Date(Date.now() - 10 * 60_000).toISOString() : null,
    completed_at: status === "completed" ? `${DAY}T13:40:00Z` : null,
    skipped_at: null,
    skip_reason: null,
    skip_reason_code: null,
    gate_reply: null,
    gate_reply_at: null,
    notes: null,
    visit_photos: [],
    zones: { name: "Lakeview East" },
    clients: { display_name: `Client ${id}`, primary_phone: null, dna_compliance_enabled: false },
    stop_facts: {
      dogCount: 0,
      autopay: true,
      cardOnFile: true,
      paysCashCheck: false,
      openBalanceCents: 0,
      awaitingCents: 0,
    },
    properties: {
      id: `p-${id}`,
      street: `${id} Elm St`,
      city: "Chicago",
      postal_code: "60657",
      lat: 41.93,
      lng: -87.66,
      account_type: "residential",
      has_units: false,
      gate_code: null,
      lock_box_code: null,
      key_location: null,
      yard_size: null,
      dogs: [],
      boundary: null,
      boundary_area_sqm: null,
      waste_stations: [],
    },
    ...over,
  };
}

const COMPLETION_PHOTO = { id: "ph-1", kind: "completion", storage_path: "org-1/v/ph-1.jpg" };

function render(visits: unknown[], org: { require_completion_photo: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["my-day", DAY, ""], {
    staff: { id: "s-1", display_name: "Jordan Tech", organization_id: "org-1" },
    previewing: false,
    visits,
  });
  qc.setQueryData(["my-org"], { organization: { id: "org-1", role: "tech", ...org } });
  const MyDay = (Route as unknown as { options: { component: () => ReactNode } }).options.component;
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(MyDay)),
  );
  // One string per card: from its <li id="visit-..."> to the next.
  const cards: Record<string, string> = {};
  const starts = [...html.matchAll(/<li[^>]*id="visit-([^"]+)"/g)];
  starts.forEach((m, i) => {
    cards[m[1]] = html.slice(m.index, starts[i + 1]?.index ?? html.length);
  });
  return cards;
}

const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const buttons = (card: string) =>
  [...card.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    attrs: m[1],
    label: text(m[2]),
  }));
const stepButtons = (card: string) => buttons(card).filter((b) => /data-visit-step=/.test(b.attrs));
/** The labels any step of the walk can carry. On a card, only the step
 *  button may carry one: anything else with that label is a second button
 *  doing the same job. */
const STEP_LABELS = ["Start", "Take completion photo", "Complete", "Take photo to complete"];

describe("My Day, rendered, one stop at each step", () => {
  const steps = (require_completion_photo: boolean) =>
    render(
      [
        visit("v-1", "scheduled"),
        visit("v-2", "in_progress"),
        visit("v-3", "in_progress", { visit_photos: [COMPLETION_PHOTO] }),
        visit("v-4", "missed"),
        visit("v-5", "completed"),
      ],
      { require_completion_photo },
    );

  it("has exactly one primary action button per open card, at the visit's step", async () => {
    await i18n.changeLanguage("en");
    const cards = steps(true);
    const want: Record<string, [string, string]> = {
      "v-1": ["start", "Start"],
      "v-2": ["photo", "Take completion photo"],
      "v-3": ["complete", "Complete"],
      "v-4": ["photo", "Take completion photo"],
    };
    for (const [id, [step, label]] of Object.entries(want)) {
      const card = cards[id];
      expect(card, `card ${id} drew`).toBeTruthy();
      const one = stepButtons(card);
      expect(one, `step buttons on ${id}`).toHaveLength(1);
      expect(one[0].attrs).toContain(`data-visit-step="${step}"`);
      expect(one[0].label).toBe(label);
      // The primary look is the step button's alone.
      const primary = buttons(card).filter((b) =>
        /class="[^"]*\bbg-primary text-primary-foreground/.test(b.attrs),
      );
      expect(
        primary.map((b) => b.label),
        `primary buttons on ${id}`,
      ).toEqual([label]);
      // Nothing beside it with a step's label: no greyed Complete next to
      // the photo, no second photo button, no Start once started.
      const doubles = buttons(card).filter(
        (b) => !/data-visit-step=/.test(b.attrs) && STEP_LABELS.includes(b.label),
      );
      expect(
        doubles.map((b) => b.label),
        `a second step button on ${id}`,
      ).toEqual([]);
    }
    // A finished card has no step at all.
    expect(stepButtons(cards["v-5"] ?? "")).toHaveLength(0);
  });

  it('keeps "Can\'t take a photo?" at the photo step, secondary, and the other photo kinds', async () => {
    await i18n.changeLanguage("en");
    const cards = steps(true);
    const v2 = buttons(cards["v-2"]);
    const cant = v2.find((b) => b.label === "Can't take a photo?");
    expect(cant, "Can't take a photo? is on the photo step").toBeTruthy();
    expect(cant!.attrs).not.toMatch(/bg-primary text-primary-foreground/);
    expect(v2.map((b) => b.label)).toContain("Take photo");
    // Not once the photo is on file.
    expect(buttons(cards["v-3"]).map((b) => b.label)).not.toContain("Can't take a photo?");
  });

  it("goes from Start straight to Complete where the business does not require a photo", async () => {
    await i18n.changeLanguage("en");
    const cards = steps(false);
    expect(stepButtons(cards["v-1"])[0].label).toBe("Start");
    for (const id of ["v-2", "v-3", "v-4"]) {
      const one = stepButtons(cards[id]);
      expect(one, id).toHaveLength(1);
      expect(one[0].label, id).toBe("Complete");
    }
    expect(buttons(cards["v-2"]).map((b) => b.label)).not.toContain("Can't take a photo?");
  });

  it("opens no camera by being drawn", async () => {
    await i18n.changeLanguage("en");
    steps(true);
    expect(camera.takePhotoNative).not.toHaveBeenCalled();
  });

  for (const [lng, label] of [
    ["es", "Tomar foto del trabajo terminado"],
    ["ar", "التقط صورة الإنجاز"],
    ["zh", "拍完工照片"],
  ] as const) {
    it(`says the photo step in ${lng}`, async () => {
      await i18n.changeLanguage(lng);
      const cards = steps(true);
      expect(stepButtons(cards["v-2"])[0].label).toBe(label);
      await i18n.changeLanguage("en");
    });
  }
});
