import { describe, expect, it } from "vitest";
import { splitCanvassAddress } from "@/lib/canvass-order";

// Walk mode prefills the signup flow from the door's one-line address. The
// split is a convenience, but a WRONG prefill is worse than none: a street
// number quoted as a ZIP prices the yard in the wrong town, in front of the
// customer. These cases are the shapes the seeder and the autocomplete
// actually emit, plus the trap.

describe("splitCanvassAddress", () => {
  it("splits the full autocomplete shape", () => {
    expect(splitCanvassAddress("612 Maple St, Southfield, MI 48037")).toEqual({
      street: "612 Maple St",
      city: "Southfield",
      region: "MI",
      postal_code: "48037",
    });
  });

  it("survives a trailing country segment", () => {
    expect(splitCanvassAddress("612 Maple St, Southfield, MI 48037, USA")).toEqual({
      street: "612 Maple St",
      city: "Southfield",
      region: "MI",
      postal_code: "48037",
    });
  });

  it("a five-digit STREET number is not a ZIP", () => {
    // The one trap: without the after-the-first-comma rule this prefills
    // postal_code "12345" and quotes the wrong town at the door.
    expect(splitCanvassAddress("12345 Main St")).toEqual({
      street: "12345 Main St",
      city: "",
      region: "",
      postal_code: "",
    });
  });

  it("city and state without a ZIP still land in their fields", () => {
    expect(splitCanvassAddress("9 Elm Ct, Austin, TX")).toEqual({
      street: "9 Elm Ct",
      city: "Austin",
      region: "TX",
      postal_code: "",
    });
  });

  it("ZIP+4 keeps the five the quote wants", () => {
    expect(splitCanvassAddress("40 Oak Ave, Troy, MI 48083-1234").postal_code).toBe("48083");
  });

  it("a bare street is a street, nothing else invented", () => {
    expect(splitCanvassAddress("7 Birch Ln")).toEqual({
      street: "7 Birch Ln",
      city: "",
      region: "",
      postal_code: "",
    });
  });
});
