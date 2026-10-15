import { describe, expect, it } from "vitest";
import {
  buildClientNamePatch,
  clientNameFormDefaults,
  splitDisplayNameForPerson,
} from "@/lib/client-name";

describe("the client editor opens with a real person name", () => {
  it("splits a legacy display name into first and last defaults", () => {
    expect(
      clientNameFormDefaults({
        display_name: "Camille Ueda",
        first_name: null,
        last_name: null,
        company: null,
      }),
    ).toEqual({ firstName: "Camille", lastName: "Ueda", company: "" });
  });

  it("keeps multi-word given names together", () => {
    expect(splitDisplayNameForPerson("Mary Ann Smith")).toEqual({
      firstName: "Mary Ann",
      lastName: "Smith",
    });
  });
});

describe("a blank-looking name field cannot erase the stored name", () => {
  const existing = {
    display_name: "Camille Ueda",
    first_name: null,
    last_name: null,
    company: null,
  };

  it("leaves name columns out of the save when all name inputs came through blank", () => {
    expect(buildClientNamePatch({ firstName: "", lastName: "", company: "" }, existing)).toEqual({
      patch: {},
      changed: false,
    });
  });

  it("backfills first and last when the derived defaults are submitted", () => {
    expect(
      buildClientNamePatch({ firstName: "Camille", lastName: "Ueda", company: "" }, existing),
    ).toEqual({
      patch: {
        first_name: "Camille",
        last_name: "Ueda",
        company: null,
        display_name: "Camille Ueda",
      },
      changed: true,
    });
  });
});
