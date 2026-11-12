// The directory's look (#898): logo A, Paw Trail colours, and the seven
// licensed photos with their credits. Pure data, so the pages, the head and
// the tests all read the same list.
//
// Every photo is from Pexels, under the Pexels License
// (https://www.pexels.com/license/): free to use and modify, attribution not
// required. Product still wants the credit visible, so each page lists the
// photos it shows, with the photographer's Pexels display name and a link to
// the photo's own Pexels page. The names and links below are the ones recorded
// for the chosen set (#898) and nothing else; do not add a photo here without
// its credit.

import { DIRECTORY_ASSET_BASE, DIRECTORY_BRAND } from "@/lib/directory-site";
import type { DirectorySearchLine } from "@/lib/directory";

/** Paw Trail, as measured against cream #fdfaf1 (contrast in brackets).
 *  Coral is decoration only: 3.13:1 is a graphic, never text. */
export const PAW_TRAIL = {
  cream: "#fdfaf1",
  navy: "#142937", // text, 14.35:1
  muted: "#48606f", // muted text, 6.33:1
  button: "#B8462A", // button fill, white text 5.32:1
  link: "#B33F22", // link text, 5.51:1
  coral: "#E8664A", // decoration only, 3.13:1
  soft: "#FBEFE6",
  line: "#EADFCF",
} as const;

export type DirectoryPhoto = {
  src: string;
  /** What is in the picture. Checked against the file, not copied from a
   *  mockup: the hero is a German Shepherd, not a golden retriever. */
  alt: string;
  width: number;
  height: number;
  /** The photographer's Pexels display name, exactly as Pexels shows it. */
  credit: string;
  /** The photo's own page on Pexels. */
  pexelsUrl: string;
  /** What the photo is of, for the credits line. */
  title: string;
};

const photo = (file: string, rest: Omit<DirectoryPhoto, "src">): DirectoryPhoto => ({
  src: `${DIRECTORY_ASSET_BASE}/photos/${file}`,
  ...rest,
});

export const DIRECTORY_HERO_PHOTO = photo("p15279808.jpg", {
  alt: "A German Shepherd lying on brick steps in front of a house",
  width: 1600,
  height: 1067,
  credit: "Julissa Pires",
  pexelsUrl: "https://www.pexels.com/photo/german-shepherd-in-front-of-a-house-15279808/",
  title: "German Shepherd in front of a house",
});

/** One photo per service, all five, so the directory never reads as one
 *  trade's. Same order as DIRECTORY_SEARCH_LINES. */
export const DIRECTORY_LINE_PHOTO: Record<DirectorySearchLine, DirectoryPhoto> = {
  pet_waste: photo("p11903184-crop.jpg", {
    alt: "A fenced backyard lawn in low sun, with a small shed against the fence",
    width: 800,
    height: 360,
    credit: "Shazard R.",
    pexelsUrl: "https://www.pexels.com/photo/wooden-shed-on-a-backyard-11903184/",
    title: "Wooden shed on a backyard",
  }),
  dog_walking: photo("p10427422.jpg", {
    alt: "A person in a red coat walking a small dog on a leash along a sidewalk",
    width: 800,
    height: 534,
    credit: "freestocks.org",
    pexelsUrl: "https://www.pexels.com/photo/person-walking-with-a-dog-on-the-sidewalk-10427422/",
    title: "Person walking with a dog on the sidewalk",
  }),
  pet_sitting: photo("p5592609.jpg", {
    alt: "A cat asleep on a soft blanket",
    width: 800,
    height: 1200,
    credit: "Francesco Ungaro",
    pexelsUrl: "https://www.pexels.com/photo/cute-cat-sleeping-on-cozy-blanket-5592609/",
    title: "Cute cat sleeping on cozy blanket",
  }),
  mobile_grooming: photo("p8498543.jpg", {
    alt: "A person brushing a long-haired dog's fur",
    width: 800,
    height: 534,
    credit: "Yaroslav Shuraev",
    pexelsUrl: "https://www.pexels.com/photo/a-person-brushing-the-dog-s-fur-8498543/",
    title: "A person brushing the dog's fur",
  }),
  training: photo("p10013053.jpg", {
    alt: "A young dog sitting and looking up at a person's hand for a treat",
    width: 800,
    height: 1203,
    credit: "Anton Kudryashov",
    pexelsUrl: "https://www.pexels.com/photo/dog-getting-snack-10013053/",
    title: "Dog getting snack",
  }),
};

/** The profile's "Before you book" picture. */
export const DIRECTORY_BEFORE_YOU_BOOK_PHOTO = photo("p9956269.jpg", {
  alt: "A woman in a grey coat walking a small dog on a leash past a white fence",
  width: 900,
  height: 1350,
  credit: "Maksim Goncharenok",
  pexelsUrl: "https://www.pexels.com/photo/woman-in-gray-coat-walking-with-her-pet-dog-9956269/",
  title: "Woman in gray coat walking with her pet dog",
});

/** Every photo the directory may show: the seven, and only the seven. */
export const DIRECTORY_PHOTOS: readonly DirectoryPhoto[] = [
  DIRECTORY_HERO_PHOTO,
  ...Object.values(DIRECTORY_LINE_PHOTO),
  DIRECTORY_BEFORE_YOU_BOOK_PHOTO,
];

/** Logo A, cream lockup (navy name, muted suffix, coral paw). The
 *  wordmark is outlined in the SVG, so no font is needed to draw it. */
export const DIRECTORY_LOCKUP = {
  src: `${DIRECTORY_ASSET_BASE}/lockup-on-cream.svg`,
  alt: DIRECTORY_BRAND,
  /** viewBox aspect, so the <img> reserves its width before it loads. */
  width: 713,
  height: 103,
} as const;

/** The document icons a directory page names: logo A's paw, so the tab reads
 *  as the directory and not as HoundStack. Scoped to /pros by directoryHead;
 *  the app's own /favicon.svg and friends are untouched. */
export function directoryIconLinks(): Array<{
  rel: string;
  href: string;
  type?: string;
  sizes?: string;
}> {
  return [
    { rel: "icon", type: "image/svg+xml", href: `${DIRECTORY_ASSET_BASE}/favicon.svg` },
    {
      rel: "icon",
      type: "image/png",
      sizes: "32x32",
      href: `${DIRECTORY_ASSET_BASE}/favicon-32.png`,
    },
    {
      rel: "icon",
      type: "image/png",
      sizes: "16x16",
      href: `${DIRECTORY_ASSET_BASE}/favicon-16.png`,
    },
    { rel: "apple-touch-icon", href: `${DIRECTORY_ASSET_BASE}/app-icon-cream-512.png` },
  ];
}
