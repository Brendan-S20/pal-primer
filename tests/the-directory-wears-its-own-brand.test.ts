// The pet-pro directory's own brand (#898): logo A, Paw Trail, and seven
// licensed Pexels photos with visible credits.
//
// Pins the decisions that a later edit could quietly undo:
//   * the photos are the seven chosen ones, each with the recorded
//     photographer and Pexels page, and each file is on disk;
//   * the hero is described as what it is (a German Shepherd), not the
//     "golden retriever" the mockup's alt text said;
//   * the brand files sit in a directory-only path, and the app's own icons
//     at public/favicon.* are still the ones the root names;
//   * HoundStack's mark is not in the directory header, only "powered by" in
//     the footer, linking to houndstack.com;
//   * all five services are offered as equal tiles, with no default;
//   * coral is never a text colour.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIRECTORY_BEFORE_YOU_BOOK_PHOTO,
  DIRECTORY_HERO_PHOTO,
  DIRECTORY_LINE_PHOTO,
  DIRECTORY_LOCKUP,
  DIRECTORY_PHOTOS,
  PAW_TRAIL,
  directoryIconLinks,
} from "@/lib/directory-brand";
import { DIRECTORY_SEARCH_LINES } from "@/lib/directory";
import { DIRECTORY_ASSET_BASE } from "@/lib/directory-site";

const ROOT = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const publicFile = (href: string) => join(ROOT, "public", href.replace(/^\//, ""));

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** The chosen set, as recorded on #898. Nothing else may be shown. */
const RECORDED = [
  ["p15279808.jpg", "Julissa Pires", "german-shepherd-in-front-of-a-house-15279808"],
  ["p10427422.jpg", "freestocks.org", "person-walking-with-a-dog-on-the-sidewalk-10427422"],
  ["p5592609.jpg", "Francesco Ungaro", "cute-cat-sleeping-on-cozy-blanket-5592609"],
  ["p8498543.jpg", "Yaroslav Shuraev", "a-person-brushing-the-dog-s-fur-8498543"],
  ["p10013053.jpg", "Anton Kudryashov", "dog-getting-snack-10013053"],
  ["p11903184-crop.jpg", "Shazard R.", "wooden-shed-on-a-backyard-11903184"],
  ["p9956269.jpg", "Maksim Goncharenok", "woman-in-gray-coat-walking-with-her-pet-dog-9956269"],
] as const;

describe("the photos", () => {
  it("are the seven recorded ones, each credited to its photographer and Pexels page", () => {
    const got = DIRECTORY_PHOTOS.map((p) => [
      p.src.split("/").pop(),
      p.credit,
      p.pexelsUrl.replace("https://www.pexels.com/photo/", "").replace(/\/$/, ""),
    ]);
    expect([...got].sort()).toEqual(RECORDED.map((r) => [...r]).sort());
  });

  it("are on disk, under the directory's own path, with no other photo beside them", () => {
    for (const p of DIRECTORY_PHOTOS) {
      expect(p.src.startsWith(`${DIRECTORY_ASSET_BASE}/photos/`), p.src).toBe(true);
      expect(existsSync(publicFile(p.src)), p.src).toBe(true);
    }
    const onDisk = readdirSync(publicFile(`${DIRECTORY_ASSET_BASE}/photos`)).sort();
    expect(onDisk).toEqual(RECORDED.map((r) => r[0]).sort());
  });

  it("put the hero, the five services and the profile picture where #898 says", () => {
    expect(DIRECTORY_HERO_PHOTO.src).toMatch(/p15279808\.jpg$/);
    expect(DIRECTORY_BEFORE_YOU_BOOK_PHOTO.src).toMatch(/p9956269\.jpg$/);
    expect(Object.keys(DIRECTORY_LINE_PHOTO).sort()).toEqual([...DIRECTORY_SEARCH_LINES].sort());
    expect(DIRECTORY_LINE_PHOTO.pet_waste.src).toMatch(/p11903184-crop\.jpg$/);
    expect(DIRECTORY_LINE_PHOTO.dog_walking.src).toMatch(/p10427422\.jpg$/);
    expect(DIRECTORY_LINE_PHOTO.pet_sitting.src).toMatch(/p5592609\.jpg$/);
    expect(DIRECTORY_LINE_PHOTO.mobile_grooming.src).toMatch(/p8498543\.jpg$/);
    expect(DIRECTORY_LINE_PHOTO.training.src).toMatch(/p10013053\.jpg$/);
  });

  it("say what is in them: the hero is a German Shepherd, and no alt is empty", () => {
    expect(DIRECTORY_HERO_PHOTO.alt).toMatch(/German Shepherd/);
    for (const p of DIRECTORY_PHOTOS) expect(p.alt.trim().length, p.src).toBeGreaterThan(10);
    for (const p of DIRECTORY_PHOTOS) expect(p.alt, p.src).not.toMatch(/golden retriever/i);
    const directoryFiles = [
      ...walk(join(ROOT, "src/components/directory")),
      ...readdirSync(join(ROOT, "src/routes"))
        .filter((f) => f.startsWith("pros."))
        .map((f) => join(ROOT, "src/routes", f)),
    ];
    const hits = directoryFiles.filter((f) => /golden retriever/i.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("never include the two photos swapped out of the set", () => {
    const hits = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "public"))].filter(
      (f) => /p19145888|p30502949/.test(f) || /p19145888|p30502949/.test(readFileSync(f, "latin1")),
    );
    expect(hits).toEqual([]);
  });

  it("are lazy and keep their box: the picture component sets loading and a size", () => {
    const src = read("src/components/directory/DirectoryPhotos.tsx");
    expect(src).toMatch(/loading=\{eager \? "eager" : "lazy"\}/);
    expect(src).toMatch(/width=\{photo\.width\}/);
    expect(src).toMatch(/height=\{photo\.height\}/);
  });

  it("are credited on the page that shows them", () => {
    expect(read("src/routes/pros.index.tsx")).toMatch(/<DirectoryPhotoCredits /);
    expect(read("src/routes/pros.$slug.index.tsx")).toMatch(
      /<DirectoryPhotoCredits photos=\{\[DIRECTORY_BEFORE_YOU_BOOK_PHOTO\]\}/,
    );
  });
});

describe("logo A and the icons", () => {
  it("are directory-only files, and every one the code names exists", () => {
    expect(DIRECTORY_ASSET_BASE).toMatch(/^\/brand\/[a-z]+$/);
    expect(existsSync(publicFile(DIRECTORY_LOCKUP.src))).toBe(true);
    for (const l of directoryIconLinks()) {
      expect(l.href.startsWith(`${DIRECTORY_ASSET_BASE}/`), l.href).toBe(true);
      expect(existsSync(publicFile(l.href)), l.href).toBe(true);
    }
    const dir = publicFile(DIRECTORY_ASSET_BASE);
    for (const f of [
      "lockup-on-cream.svg",
      "lockup-on-navy.svg",
      "lockup-mono-navy.svg",
      "lockup-mono-cream.svg",
      "paw.svg",
      "paw-mono-navy.svg",
      "paw-small-sizes.svg",
      "paw-512.png",
      "favicon.svg",
      "favicon-32.png",
      "favicon-16.png",
      "app-icon-cream.svg",
      "app-icon-coral.svg",
      "app-icon-cream-512.png",
      "app-icon-coral-512.png",
    ]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
  });

  it("leave the app's own icons where the root names them", () => {
    const root = read("src/routes/__root.tsx");
    expect(root).toMatch(/href: "\/favicon\.svg"/);
    expect(root).toMatch(/href: "\/apple-touch-icon\.png"/);
    // The app favicon is HoundStack's, not the directory's coral paw.
    expect(read("public/favicon.svg")).not.toMatch(/#E8664A/i);
  });

  it("the lockup is in the header, and HoundStack only as 'powered by' in the footer", () => {
    const shell = read("src/components/directory/DirectoryShell.tsx");
    const header = shell.slice(shell.indexOf("<header"), shell.indexOf("</header>"));
    expect(header).toMatch(/<DirectoryLockup /);
    expect(header).not.toMatch(/<Logo\b/);
    const after = shell.slice(shell.indexOf("</header>"));
    expect(after).toMatch(/<DirectoryLockup /);
    expect(after).toMatch(/href="https:\/\/houndstack\.com"[^]*powered by[^]*<Logo /);
    expect(shell).toMatch(/\{DIRECTORY_DISCLOSURE\}/);
  });
});

describe("Paw Trail", () => {
  it("is scoped to the directory and never uses coral as text", () => {
    const css = read("src/styles.css");
    expect(css).toMatch(/\[data-directory-brand\] \{/);
    expect(read("src/components/directory/DirectoryShell.tsx")).toMatch(/data-directory-brand/);
    const coral = PAW_TRAIL.coral.replace("#", "");
    for (const f of walk(join(ROOT, "src"))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(new RegExp(`text-\\[#${coral}\\]`, "i"));
    }
  });

  it("keeps every text colour at WCAG AA on cream", () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const l = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
      return (x + 0.05) / (y + 0.05);
    };
    for (const t of [PAW_TRAIL.navy, PAW_TRAIL.muted, PAW_TRAIL.link]) {
      expect(ratio(t, PAW_TRAIL.cream), t).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, PAW_TRAIL.soft), `${t} on soft`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio("#ffffff", PAW_TRAIL.button)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(PAW_TRAIL.coral, PAW_TRAIL.cream)).toBeLessThan(4.5); // why it is never text
  });
});

describe("the five services", () => {
  it("are five equal tiles with nothing chosen by default, not a dropdown", () => {
    const src = read("src/routes/pros.index.tsx");
    expect(src).not.toMatch(/<select\b/);
    expect(src).not.toMatch(/"pet_waste"/);
    expect(src).toMatch(
      /DIRECTORY_SEARCH_LINES\.map\(\(l\) => \(\s*<ServiceTile key=\{l\} line=\{l\} checked=\{search\.line === l\} \/>/,
    );
    expect(DIRECTORY_SEARCH_LINES).toHaveLength(5);
  });
});
