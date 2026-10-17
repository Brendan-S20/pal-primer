import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getUser: vi.fn(), getVerifiedUser: vi.fn() }));
const local = vi.hoisted(() => ({ hasSeen: vi.fn(), remember: vi.fn() }));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (fn: () => void) => fn(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getUser: auth.getUser } },
  isImpersonationTab: () => false,
}));
vi.mock("@/lib/offline/identity", () => ({ getVerifiedUser: auth.getVerifiedUser }));
vi.mock("@/lib/offline/read-cache", () => ({ readLastUser: () => "user-1" }));
vi.mock("@/lib/tour-seen", () => ({
  hasSeenTourLocally: local.hasSeen,
  rememberTourSeen: local.remember,
  forgetTourSeen: vi.fn(),
}));
vi.mock("@/hooks/useMyRole", () => ({ canAccess: () => true }));

import { __resetSetupGuideForTests, useSetupGuide } from "@/lib/setup-guide";

beforeEach(() => {
  vi.resetAllMocks();
  __resetSetupGuideForTests();
  local.hasSeen.mockReturnValue(false);
  auth.getVerifiedUser.mockReturnValue(null);
});

describe("setup guide identity", () => {
  it.each([true, false])("reuses the verified tour metadata when seen is %s", async (seen) => {
    auth.getVerifiedUser.mockReturnValue({
      id: "user-1",
      user_metadata: { tour_seen_at: seen ? "2026-10-15" : null },
    });
    useSetupGuide();
    await Promise.resolve();
    expect(useSetupGuide()).toEqual({ phase: seen ? "closed" : "open", userId: "user-1" });
    expect(auth.getUser).not.toHaveBeenCalled();
    if (seen) expect(local.remember).toHaveBeenCalledWith("user-1");
  });

  it("keeps the Auth request when no verified user is available", async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: "user-1", user_metadata: {} } } });
    useSetupGuide();
    await Promise.resolve();
    expect(auth.getUser).toHaveBeenCalledTimes(1);
    expect(useSetupGuide()).toEqual({ phase: "open", userId: "user-1" });
  });

  it("keeps a local dismissal without reading Auth", () => {
    local.hasSeen.mockReturnValue(true);
    expect(useSetupGuide()).toEqual({ phase: "closed", userId: "user-1" });
    expect(auth.getVerifiedUser).not.toHaveBeenCalled();
    expect(auth.getUser).not.toHaveBeenCalled();
  });
});
