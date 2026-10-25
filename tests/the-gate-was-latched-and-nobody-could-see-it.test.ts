// The gate was latched and nobody could see it.
//
// The complaint that ends a pet-waste account is a dog out of the yard, and
// the first question after one is "did your tech close the gate?". A tech
// could photograph the gate, but only as one of before / completion / issue,
// so the answer went to the customer as an uncaptioned "After" picture, if at
// all. These pin the four places the new kind has to reach, and the one place
// it deliberately does not.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PHOTO_KINDS,
  PHOTO_KIND_OPTIONS,
  pickEmailedPhotos,
  photoKindLabel,
} from "@/lib/photo-kinds";
import { photoCaption } from "@/lib/portal-ui";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const MIG = "supabase/migrations/20260928140000_the-gate-was-latched-and-nobody-could-see-it.sql";

describe("a tech can say a photo is of the latched gate", () => {
  it("is a kind the app validates and the database accepts", () => {
    expect(PHOTO_KINDS).toContain("gate");
    expect(read(MIG)).toMatch(/CHECK \(kind IN \('completion', 'before', 'issue', 'gate'\)\)/);
  });

  it("is offered in both pickers, by name", () => {
    expect(PHOTO_KIND_OPTIONS.map((o) => o.value).sort()).toEqual([...PHOTO_KINDS].sort());
    expect(photoKindLabel("gate")).toBe("Home secured");
    // Both pickers render the list rather than spelling the options out, which
    // is how the drawer and My Day stay offering the same four.
    for (const f of [
      "src/components/VisitDetailDrawer.tsx",
      "src/routes/_authenticated/my-day.tsx",
    ]) {
      const src = read(f);
      expect(src, f).toMatch(/PHOTO_KIND_OPTIONS\.map/);
      expect(src, f).not.toMatch(/<option value="issue">/);
    }
  });

  it("no longer spells the union out by hand anywhere in src", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && /"before" \| "completion" \| "issue"/.test(read(p)))
          hits.push(p);
      }
    };
    walk("src");
    expect(hits).toEqual([]);
  });

  it("is captioned for the customer", () => {
    expect(photoCaption("gate")).toBe("Gate latched");
  });
});

describe("the customer is sent it", () => {
  const rows = [
    { storage_path: "o/v/1.jpg", kind: "completion" },
    { storage_path: "o/v/2.jpg", kind: "gate" },
    { storage_path: "o/v/3.jpg", kind: "completion" },
    { storage_path: "o/v/4.jpg", kind: "completion" },
    { storage_path: "o/v/5.jpg", kind: "completion" },
    { storage_path: "o/v/6.jpg", kind: "gate" },
  ];

  it("with the newest gate photo, and still at most three of the yard", () => {
    expect(pickEmailedPhotos(rows)).toEqual({
      completion: ["o/v/1.jpg", "o/v/3.jpg", "o/v/4.jpg"],
      gate: "o/v/6.jpg",
    });
  });

  it("and nothing when there is no gate photo", () => {
    expect(pickEmailedPhotos(rows.filter((r) => r.kind !== "gate")).gate).toBeNull();
  });

  it("asks the database for gate photos and hands the template its own URL", () => {
    const fn = read("src/lib/my-day.functions.ts");
    expect(fn).toMatch(/\.in\("kind", PHOTO_KINDS_EMAILED\)/);
    expect(fn).toMatch(/gatePhotoUrl,/);
    const tpl = read("src/lib/email-templates/visit-completed.tsx");
    expect(tpl).toMatch(/gatePhotoUrl \?/);
    expect(tpl).toMatch(/alt="Gate latched"/);
  });
});

describe("a gate photo is not the completion photo", () => {
  it("leaves the required-photo rule looking for completion only", () => {
    // A latched gate proves the yard was shut, not that it was cleaned.
    // complete_visit and confirm_open_visit are not redefined by this change.
    expect(read(MIG)).not.toMatch(/CREATE OR REPLACE FUNCTION/);
    const myDay = read("src/routes/_authenticated/my-day.tsx");
    expect(myDay).toMatch(/photos\.some\(\(p: any\) => p\.kind === "completion"\)/);
  });
});
