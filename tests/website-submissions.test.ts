import { describe, expect, it } from "vitest";
import { corsHeadersForOrigin, validateWebsiteSubmission } from "@/lib/website-submissions";

const base = {
  form: "contact",
  name: "Brendan",
  email: "brendan@example.com",
  message: "I want to talk.",
  source_page: "https://www.houndstack.com/contact",
};

describe("website submissions", () => {
  it("allows only the marketing origins", () => {
    expect(corsHeadersForOrigin("https://houndstack.com")).toMatchObject({
      "Access-Control-Allow-Origin": "https://houndstack.com",
    });
    expect(corsHeadersForOrigin("https://www.houndstack.com")).toMatchObject({
      "Access-Control-Allow-Origin": "https://www.houndstack.com",
    });
    expect(corsHeadersForOrigin("https://evil.example")).toBeNull();
    expect(corsHeadersForOrigin(null)).toBeNull();
  });

  it("accepts a normal contact submission", () => {
    const result = validateWebsiteSubmission({ ...base, team_size: "3" });
    expect(result).toMatchObject({
      ok: true,
      data: {
        form: "contact",
        email: "brendan@example.com",
        payload: { team_size: "3" },
      },
    });
  });

  it("rejects invalid input before storage", () => {
    const result = validateWebsiteSubmission({ ...base, email: "not an email" });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("accepts contact submissions without a message", () => {
    const result = validateWebsiteSubmission({ ...base, message: "" });
    expect(result).toMatchObject({ ok: true });
  });

  it("silently drops honeypot submissions", () => {
    const result = validateWebsiteSubmission({ ...base, website_url: "https://spam.example" });
    expect(result).toEqual({ ok: false, status: 200, dropped: true, reason: "honeypot" });
  });

  it("silently drops submissions that claim an impossible fill time", () => {
    const now = Date.UTC(2026, 9, 12, 12, 0, 0);
    const result = validateWebsiteSubmission({ ...base, started_at: now - 500 }, now);
    expect(result).toEqual({ ok: false, status: 200, dropped: true, reason: "too_fast" });
  });

  it("does not require the timestamp field", () => {
    const result = validateWebsiteSubmission({
      form: "early_access",
      name: "Taylor",
      email: "taylor@example.com",
    });
    expect(result).toMatchObject({ ok: true });
  });
});
