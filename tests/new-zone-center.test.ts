import { describe, expect, it, vi } from "vitest";
import { newZoneCenter } from "@/lib/new-zone-center";

const org = { contact_address: "Lansing, MI", latitude: 40, longitude: -80 };
describe("new zone opening center", () => {
  it("prefers the business address over the org start point", async () => {
    const geocode = vi.fn().mockResolvedValue({ latitude: 42.73, longitude: -84.55 });
    expect(await newZoneCenter(org, geocode)).toEqual({ lat: 42.73, lng: -84.55 });
    expect(geocode).toHaveBeenCalledWith("Lansing, MI");
  });
  it.each([null, { latitude: NaN, longitude: -84 }, { latitude: 91, longitude: 0 }])(
    "falls back to the org geocoded start point when lookup returns %s",
    async (result) => {
      expect(await newZoneCenter(org, async () => result)).toEqual({ lat: 40, lng: -80 });
    },
  );
  it("falls back when geocoding throws", async () => {
    expect(
      await newZoneCenter(org, async () => {
        throw new Error("offline");
      }),
    ).toEqual({ lat: 40, lng: -80 });
  });
  it("uses the stored point without looking up a blank address, including zero coordinates", async () => {
    const geocode = vi.fn();
    expect(
      await newZoneCenter({ contact_address: " ", latitude: 0, longitude: 0 }, geocode),
    ).toEqual({ lat: 0, lng: 0 });
    expect(geocode).not.toHaveBeenCalled();
  });
  it("leaves the existing US view when neither source is located", async () => {
    expect(
      await newZoneCenter({ ...org, latitude: null, longitude: null }, async () => null),
    ).toBeNull();
  });
});
