/**
 * The words around a property's boundary, by what the business runs (#768).
 *
 * The boundary is drawn on every property, but it is a pet-waste business
 * that prices and times a visit by it: "yard size" is the scooper's measure.
 * A business that walks, sits, grooms or trains sees the same sketch and the
 * same Save, described as the property's outline and nothing more. Until the
 * service lines are known `useServiceLines()` reports pet waste, so the
 * fail-open is the wording every business saw before.
 */
export type BoundaryCopy = {
  drawerDescription: string;
  matchedPinHint: string;
  newSectionHelp: string;
  editSectionHelp: string;
  emptyHint: string;
  sizeLabel: string;
  accessNotesPlaceholder: string;
  stationsHint: string;
  /** What BoundarySketch's help line says the outline goes around. */
  areaNoun: "yard" | "property";
};

const PET_WASTE: BoundaryCopy = {
  drawerDescription:
    "The service zone is detected automatically from the address. Draw the boundary on the map to set yard size and estimated time.",
  matchedPinHint: "Map pin placed automatically. Draw the boundary below to set yard size.",
  newSectionHelp:
    "Outline the serviced yard now; it saves with the property. Yard size and estimated time are derived from it automatically.",
  editSectionHelp:
    "Outline the serviced yard; it saves with your changes. Yard size and estimated time are derived from it automatically.",
  emptyHint: "Yard size and estimated time come from the boundary.",
  sizeLabel: "Yard size",
  accessNotesPlaceholder: "How to get into the yard, e.g. side gate on the left",
  stationsHint: "Separate entries with commas. Waste stations are managed in the Services tab.",
  areaNoun: "yard",
};

const ANY_DOOR: BoundaryCopy = {
  drawerDescription:
    "The service zone is detected automatically from the address. Drawing the property's boundary on the map is optional.",
  matchedPinHint: "Map pin placed automatically.",
  newSectionHelp: "Optional. Outline the property now; it saves with the property.",
  editSectionHelp: "Optional. Outline the property; it saves with your changes.",
  emptyHint: "Optional. Outline the property if it helps your team.",
  sizeLabel: "Property size",
  accessNotesPlaceholder: "How to get in, e.g. side gate on the left, key in the lockbox",
  stationsHint: "Separate entries with commas.",
  areaNoun: "property",
};

export function boundaryCopy(petWaste: boolean): BoundaryCopy {
  return petWaste ? PET_WASTE : ANY_DOOR;
}
