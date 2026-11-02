// #680: lead conversion and signup write properties.access_notes, but the
// client Properties card showed only the gate code ("No gate code") and the
// Edit property drawer did not load the note, so an owner thought it was lost.
// The note now shows on the card, loads in the drawer, and a save that did not
// touch it leaves the stored text alone.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { accessNotesSave } from "@/lib/walk-access";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("accessNotesSave", () => {
  it("sends nothing when the note was left alone, so the stored text stays", () => {
    const out = accessNotesSave(
      { accessNotes: "Side gate on the left, latch sticks" },
      { accessNotes: " Side gate on the left, latch sticks " },
    );
    expect(out).toEqual({});
    expect("accessNotes" in out).toBe(false);
  });

  it("sends nothing for an empty note nobody touched", () => {
    expect(accessNotesSave({ accessNotes: "" }, { accessNotes: "  " })).toEqual({});
  });

  it("sends an edited note, trimmed", () => {
    expect(accessNotesSave({ accessNotes: "" }, { accessNotes: " Use the back gate " })).toEqual({
      accessNotes: "Use the back gate",
    });
  });

  it("sends null for a note the user cleared", () => {
    expect(accessNotesSave({ accessNotes: "Use the back gate" }, { accessNotes: "" })).toEqual({
      accessNotes: null,
    });
  });
});

describe("the office sees and keeps access_notes", () => {
  const list = read("src/lib/properties.functions.ts");
  const drawer = read("src/components/client-detail/PropertyDrawer.tsx");
  const tab = read("src/components/client-detail/PropertiesTab.tsx");

  it("lists access_notes for the client's properties", () => {
    const m = list.match(/listPropertiesForClient[\s\S]*?\.select\(\s*"([^"]+)"/);
    expect(m?.[1].split(/\s*,\s*/)).toContain("access_notes");
  });

  it("writes access_notes on update only when the caller sent it", () => {
    expect(list).toMatch(
      /data\.accessNotes !== undefined\s*\?\s*\{ access_notes: data\.accessNotes\?\.trim\(\) \|\| null \}\s*:\s*\{\}/,
    );
  });

  it("loads the stored note into Edit property and saves it through accessNotesSave", () => {
    expect(drawer).toMatch(/accessNotes: \(property\?\.access_notes \?\? ""\)/);
    expect(drawer).toMatch(/\.\.\.accessNotesSave\(initial, form\)/);
    expect(drawer).toMatch(/<Label htmlFor="pd-access-notes">Access notes<\/Label>/);
  });

  it("shows the note on the Properties card under its own label", () => {
    expect(tab).toMatch(/Access notes: <bdi[^>]*>\{p\.access_notes\}<\/bdi>/);
  });
});
