// @vitest-environment happy-dom
//
// #1021. Record progress on a phone:
//   - at 390px the skill names were squeezed to one letter per line (name span
//     flex-1 + min-w-0 + break-words beside five 44px buttons that never
//     wrap). The name now has a real width: its own line under 480px, and a
//     minimum width beside the scores above it.
//   - offline, the panel printed the browser's raw "Failed to fetch". It now
//     says the trainer is offline and what happens to scores tapped meanwhile.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";
import zh from "@/lib/i18n/locales/zh";
import ar from "@/lib/i18n/locales/ar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  get: vi.fn(async (_a: unknown): Promise<unknown> => ({})),
}));
vi.mock("@tanstack/react-start", () => ({
  useServerFn: (f: unknown) => f,
  createServerFn: () => {
    const b: any = {
      middleware: () => b,
      inputValidator: () => b,
      handler: () => async () => ({}),
    };
    return b;
  },
}));
vi.mock("@/lib/training-progress.functions", () => ({
  getSessionProgress: (a: unknown) => h.get(a),
  saveSessionProgress: async () => ({}),
}));
vi.mock("@/lib/training-packages.functions", () => ({ getTrainingSession: async () => null }));
vi.mock("@/lib/i18n", () => ({ useIntlLocale: () => "en" }));

const { TrainingProgressPanel, isNoAnswerError } =
  await import("@/components/training/TrainingProgressPanel");

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

async function mount() {
  await i18next.use(initReactI18next).init({ lng: "en", resources: { en: { translation: en } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(TrainingProgressPanel as any, { visitId: "v1", serviceLine: "training" }),
      ),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("Record progress, offline", () => {
  it("never shows the browser's raw words", async () => {
    h.get.mockRejectedValue(new TypeError("Failed to fetch"));
    await mount();
    expect(host!.textContent).not.toContain("Failed to fetch");
    expect(host!.textContent).toContain("You're offline.");
    expect(host!.textContent).toContain("stay on this screen");
  });

  it("still shows a real server message as it is", async () => {
    h.get.mockRejectedValue(new Error("Only the assigned trainer can record progress."));
    await mount();
    expect(host!.textContent).toContain("Only the assigned trainer can record progress.");
  });

  it("recognises each browser's no-answer wording", () => {
    for (const m of [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
    ])
      expect(isNoAnswerError(new TypeError(m))).toBe(true);
    expect(isNoAnswerError(new Error("Forbidden"))).toBe(false);
  });

  it("is said in every language the tech app speaks", () => {
    for (const [name, t] of Object.entries({ es, zh, ar }))
      expect((t as any).training.offline, name).toBeTruthy();
  });
});

describe("a skill name on a phone", () => {
  const src = readFileSync(
    join(__dirname, "..", "src/components/training/TrainingProgressPanel.tsx"),
    "utf8",
  );
  it("has its own line under 480px and a minimum width above it, never flex-1 from zero", () => {
    const name = src.match(/<span className="([^"]*)">\s*<bdi>\{skill\.name\}/)![1];
    expect(name).toContain("w-full");
    expect(name).toContain("min-[480px]:min-w-32");
    expect(name).not.toMatch(/(^| )min-w-0( |$)/);
    expect(name).not.toMatch(/(^| )flex-1( |$)/);
  });
});
