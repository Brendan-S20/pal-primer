// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ZoneCoverageMap } from "@/components/ZoneCoverageMap";

vi.mock("@/lib/maps/use-map-renderer", () => ({ useMapRenderer: () => null }));
afterEach(cleanup);

it("switches every coverage mode without submitting or saving the drawer form", () => {
  const submit = vi.fn((event) => event.preventDefault());
  const save = vi.fn();
  render(
    createElement(
      "form",
      { onSubmit: submit },
      createElement(ZoneCoverageMap, {
        initial: {
          mode: "radius",
          polygon: null,
          centerLat: 42,
          centerLng: -83,
          radiusMeters: 1600,
          driveTimeMinutes: null,
        },
        onChange: vi.fn(),
        onSave: save,
      }),
    ),
  );
  for (const name of ["Polygon", "Drive time", "Radius"]) {
    fireEvent.click(screen.getByRole("button", { name, exact: true }));
    expect(submit).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  }
});
