// Shared Stripe Elements appearance: every Payment Element in the app (owner
// invoice, portal pay, card setup, plan upgrade) reads the app's design
// tokens so the form looks like part of the page, not an embedded Stripe
// page. Client-side only — reads computed CSS custom properties.
import type { Appearance } from "@stripe/stripe-js";

function cssHsl(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `hsl(${raw})` : fallback;
}

export function stripeAppearance(): Appearance {
  return {
    theme: "stripe",
    variables: {
      colorPrimary: cssHsl("--primary", "hsl(222 47% 11%)"),
      colorBackground: cssHsl("--card", "#ffffff"),
      colorText: cssHsl("--foreground", "hsl(222 47% 11%)"),
      colorDanger: cssHsl("--destructive", "hsl(0 84% 60%)"),
      borderRadius: "8px",
      fontFamily:
        typeof document !== "undefined"
          ? getComputedStyle(document.body).fontFamily
          : "ui-sans-serif, system-ui, sans-serif",
      fontSizeBase: "14px",
    },
    rules: {
      ".Label": { fontSize: "13px", fontWeight: "500" },
    },
  };
}
