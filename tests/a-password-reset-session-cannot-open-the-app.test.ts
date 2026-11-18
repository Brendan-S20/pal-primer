// #983: a password-reset link makes a real session, shared by every tab. It
// may only be used to set a new password; abandoning the reset signs it out.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  abandonRecovery,
  clearRecoveryPending,
  isRecoveryPending,
  markRecoveryPending,
} from "@/lib/password-recovery";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("abandoning a reset", () => {
  it("signs this device out locally, then lowers the flag", async () => {
    const store = memoryStore();
    markRecoveryPending(store);
    const signOut = vi.fn().mockResolvedValue({ error: null });
    await abandonRecovery({ auth: { signOut } }, store);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(isRecoveryPending(store)).toBe(false);
  });

  it("keeps the flag up when sign-out fails, so the app stays shut", async () => {
    const store = memoryStore();
    markRecoveryPending(store);
    await abandonRecovery(
      { auth: { signOut: vi.fn().mockResolvedValue({ error: new Error("x") }) } },
      store,
    );
    expect(isRecoveryPending(store)).toBe(true);
    await abandonRecovery(
      { auth: { signOut: vi.fn().mockRejectedValue(new Error("offline")) } },
      store,
    );
    expect(isRecoveryPending(store)).toBe(true);
    clearRecoveryPending(store);
  });
});

describe("the wiring", () => {
  it("the flag is in storage every tab shares, not per-tab sessionStorage", () => {
    const src = read("src/lib/password-recovery.ts");
    expect(src).toMatch(/window\.localStorage/);
  });
  it("the signed-in app is closed to a pending reset before identity is read", () => {
    const src = read("src/routes/_authenticated/route.tsx");
    const guard = src.indexOf("isRecoveryPending()");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(src.indexOf("resolveIdentity()", guard));
    expect(src).toMatch(/redirect\(\{ to: RESET_PASSWORD_PATH \}\)/);
  });
  it("'Back to sign in' abandons the reset instead of just dropping the flag", () => {
    const src = read("src/routes/reset-password.tsx");
    expect(src).toMatch(/abandonRecovery\(supabase\)/);
    expect(src).not.toMatch(/onClick=\{\(\) => clearRecoveryPending\(\)\}/);
  });
});
