// @vitest-environment happy-dom
//
// #944, Nov 16 2026 QA run: on /clients/new the tester cleared the dog's
// Name and Breed and read "Bailey" and "Lab mix" back as real values.
//
// In the code they were placeholders only -- `value={d.name}` /
// `value={d.breed}`, nothing writes those words in -- so what the tester saw
// was either muted placeholder text that reads like a dog on file, or the
// browser's autofill offering a remembered value. Either way an owner can
// believe a dog is named Bailey. The same mistake was made on #943 with a
// route start of "123 Main St, Austin, TX 78701" on a Michigan business.
//
// Held here:
//   1. both boxes are autoComplete="off" and their hints say "e.g.";
//   2. cleared and blurred, both boxes stay "" (driven, not read from source);
//   3. a dog saved with no breed sends no breed and stores null -- never
//      "Lab mix" -- on both sides of onboardClient;
//   4. no client or team form hints with a bare name or a street address.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DogNameAndBreedFields } from "@/components/DogNameAndBreedFields";
import {
  DOG_BREED_PLACEHOLDER,
  DOG_NAME_PLACEHOLDER,
  newClientDogBreed,
  storedDogBreed,
} from "@/lib/new-client-dogs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (file: string) => readFileSync(join(import.meta.dirname, "..", file), "utf8");

let host: HTMLDivElement;
let root: Root;
let latest: { name: string; breed: string };

function Row({ initial }: { initial: { name: string; breed: string } }) {
  const [dog, setDog] = useState(initial);
  latest = dog;
  return createElement(DogNameAndBreedFields, {
    name: dog.name,
    breed: dog.breed,
    onChange: (patch) => setDog((d) => ({ ...d, ...patch })),
  });
}

/** Types into a controlled input the way React listens for it. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function blur(input: HTMLInputElement) {
  act(() => {
    input.focus();
    input.blur();
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

const boxes = () => {
  const [name, breed] = Array.from(host.querySelectorAll("input"));
  return { name, breed };
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the Dogs step's Name and Breed boxes", () => {
  it("hint with an example, never a bare value, and turn autofill off", () => {
    act(() => root.render(createElement(Row, { initial: { name: "", breed: "" } })));
    const { name, breed } = boxes();
    expect(name.getAttribute("placeholder")).toBe("e.g. Bailey");
    expect(breed.getAttribute("placeholder")).toBe("e.g. Lab mix");
    expect(name.getAttribute("autocomplete")).toBe("off");
    expect(breed.getAttribute("autocomplete")).toBe("off");
    expect(DOG_NAME_PLACEHOLDER).toMatch(/^e\.g\. /);
    expect(DOG_BREED_PLACEHOLDER).toMatch(/^e\.g\. /);
  });

  it("cleared and blurred, both stay empty", () => {
    act(() => root.render(createElement(Row, { initial: { name: "", breed: "" } })));
    const { name, breed } = boxes();
    type(name, "Bailey");
    type(breed, "Lab mix");
    expect(latest).toEqual({ name: "Bailey", breed: "Lab mix" });

    type(name, "");
    blur(name);
    type(breed, "");
    blur(breed);

    expect(name.value).toBe("");
    expect(breed.value).toBe("");
    expect(latest).toEqual({ name: "", breed: "" });
  });

  it("is what the wizard draws", () => {
    const wizard = read("src/routes/_authenticated/clients.new.tsx");
    expect(wizard).toContain("<DogNameAndBreedFields");
    expect(wizard).not.toMatch(/placeholder="(Bailey|Lab mix)"/);
  });
});

describe("a dog saved with no breed", () => {
  it("sends no breed from the wizard", () => {
    expect(newClientDogBreed("")).toBeUndefined();
    expect(newClientDogBreed("   ")).toBeUndefined();
    expect(newClientDogBreed(undefined)).toBeUndefined();
    expect(newClientDogBreed(" Beagle ")).toBe("Beagle");
  });

  it("is stored as null by onboardClient, never the example", () => {
    expect(storedDogBreed(undefined)).toBeNull();
    expect(storedDogBreed("")).toBeNull();
    expect(storedDogBreed("  ")).toBeNull();
    expect(storedDogBreed(newClientDogBreed(""))).toBeNull();
    expect(storedDogBreed(newClientDogBreed(""))).not.toBe(DOG_BREED_PLACEHOLDER);
  });

  it("goes through those two functions on each side", () => {
    const wizard = read("src/routes/_authenticated/clients.new.tsx");
    expect(wizard).toContain("breed: newClientDogBreed(d.breed)");
    const server = read("src/lib/clients.functions.ts");
    expect(server).toContain("breed: storedDogBreed(d.breed)");
  });
});

describe("client and team forms", () => {
  // The forms an owner fills in about a client, a teammate, or the business
  // address a route starts from (#943).
  const FORMS = [
    "src/routes/_authenticated/clients.new.tsx",
    "src/routes/_authenticated/settings.users.tsx",
    "src/routes/_authenticated/setup.tsx",
    "src/components/DogNameAndBreedFields.tsx",
    "src/components/client-detail/EditClientDrawer.tsx",
    "src/components/client-detail/PropertyDrawer.tsx",
    "src/components/client-detail/PropertiesTab.tsx",
    "src/components/client-detail/stations-panel.tsx",
    "src/components/settings/BusinessDetailsCards.tsx",
    "src/components/settings/ClientPortalCards.tsx",
    "src/components/routes/StaffRoutingDialog.tsx",
  ];
  /** Every string literal a placeholder can show, ternary branches included. */
  const placeholders = (src: string) =>
    [...src.matchAll(/placeholder=(?:"([^"]*)"|\{([^}]*)\})/g)].flatMap((m) =>
      m[1] != null ? [m[1]] : [...m[2].matchAll(/"([^"]*)"/g)].map((q) => q[1]),
    );

  it("hint a street address by its parts, not with a made-up one", () => {
    const offenders = FORMS.flatMap((f) =>
      placeholders(read(f))
        .filter((p) => /\b\d+\s+\w+\s+(St|Ave|Rd|Blvd|Dr|Ln)\b/.test(p))
        .map((p) => `${f}: "${p}"`),
    );
    expect(offenders).toEqual([]);
  });

  it("mark a sample name, phone or place as an example", () => {
    const samples = [
      "Bailey",
      "Lab mix",
      "Jane Doe",
      "Oakwood HOA",
      "(555) 123-4567",
      "Eastside Animal Hospital",
      "K-12",
    ];
    const offenders = FORMS.flatMap((f) =>
      placeholders(read(f))
        .filter((p) => samples.includes(p))
        .map((p) => `${f}: "${p}"`),
    );
    expect(offenders).toEqual([]);
  });
});
