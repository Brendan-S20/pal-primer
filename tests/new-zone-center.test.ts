import { describe, expect, it, vi } from "vitest";
import { newZoneCenter } from "@/lib/new-zone-center";

const located = { contact_address: "Lansing, MI", latitude: 42.73, longitude: -84.55 };
const unlocated = { ...located, latitude: null, longitude: null };
describe("new zone opening center", () => {
  it("uses stored coordinates without calling the geocoder, even with an address", async () => {
    const geocode = vi.fn().mockRejectedValue(new Error("must not make a paid call"));
    expect(await newZoneCenter(located, geocode)).toEqual({ lat: 42.73, lng: -84.55 });
    expect(geocode).not.toHaveBeenCalled();
  });
  it.each([
    { latitude: null, longitude: null },
    { latitude: null, longitude: -84.55 },
    { latitude: 42.73, longitude: null },
  ])("geocodes when stored coordinates are incomplete: %s", async (coords) => {
    const geocode = vi.fn().mockResolvedValue({ latitude: 42.73, longitude: -84.55 });
    expect(await newZoneCenter({ ...located, ...coords }, geocode)).toEqual({
      lat: 42.73,
      lng: -84.55,
    });
    expect(geocode).toHaveBeenCalledExactlyOnceWith("Lansing, MI");
  });
  it.each([null, { latitude: NaN, longitude: -84 }, { latitude: 91, longitude: 0 }])(
    "leaves the US view when lookup returns %s",
    async (result) => {
      expect(await newZoneCenter(unlocated, async () => result)).toBeNull();
    },
  );
  it("leaves the US view when geocoding throws", async () => {
    expect(
      await newZoneCenter(unlocated, async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });
  it("accepts zero coordinates without looking up the address", async () => {
    const geocode = vi.fn();
    expect(await newZoneCenter({ ...located, latitude: 0, longitude: 0 }, geocode)).toEqual({
      lat: 0,
      lng: 0,
    });
    expect(geocode).not.toHaveBeenCalled();
  });
  it("does not geocode a blank address", async () => {
    const geocode = vi.fn();
    expect(await newZoneCenter({ ...unlocated, contact_address: " " }, geocode)).toBeNull();
    expect(geocode).not.toHaveBeenCalled();
  });
});
