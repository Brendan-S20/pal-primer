// ── STRIPE CONNECT APPEARANCE: A FINGER, AND THE DARK PALETTE ────────────
//
// Stripe's embedded Connect components are iframes on Stripe's origin, so no
// class or CSS variable of ours reaches inside them. `appearance.variables`
// is the only lever, and this builds it from two independent facts:
//
//   coarse  a finger is the pointer: bigger type and more padding. Sizes only.
//   dark    the app is in dark mode (theme.ts put "dark" on <html>): the
//           panels take the app's dark palette instead of drawing a white
//           box on a dark page. Colours only.
//
// They combine: a dark iPad gets both, a mouse in dark mode gets colours only,
// and a mouse in light mode gets an empty `variables`, which is Stripe's
// defaults and exactly today's light look. Light mode sets no colour on
// purpose; the light panels were reviewed as Stripe draws them.
//
// Pure, so the decision is testable without a browser or a Stripe session
// (tests/stripe-connect-follows-the-theme.test.ts).

import type { AppearanceOptions, AppearanceVariables } from "@stripe/connect-js";

/** What Stripe lets us change for a finger. There is no height, min-height or
 *  hit-area variable, so this makes the controls larger, not 44pt. */
export const COARSE_POINTER_VARIABLES = {
  fontSizeBase: "16px",
  spacingUnit: "11px",
  buttonPaddingY: "12px",
  buttonPaddingX: "16px",
  buttonLabelFontSize: "16px",
  inputFieldPaddingY: "12px",
  inputFieldPaddingX: "12px",
  tableRowPaddingY: "14px",
} satisfies AppearanceVariables;

// The `.dark` palette in src/styles.css, as Stripe will take it. Stripe accepts
// hex, rgb() and hsl() strings, not oklch(), so each value is the hex the
// oklch() names (they are Tailwind's slate and red steps, which shadcn's dark
// theme is built from). Change one here when its variable changes there.
const DARK = {
  card: "#0f172a", //               --card               oklch(0.208 0.042 265.755)  slate-900
  foreground: "#f8fafc", //         --foreground         oklch(0.984 0.003 247.858)  slate-50
  primary: "#e2e8f0", //            --primary            oklch(0.929 0.013 255.508)  slate-200
  primaryForeground: "#0f172a", //  --primary-foreground oklch(0.208 0.042 265.755)  slate-900
  secondary: "#1e293b", //          --secondary, --muted oklch(0.279 0.041 260.031)  slate-800
  mutedForeground: "#94a3b8", //    --muted-foreground   oklch(0.704 0.04 256.788)   slate-400
  destructive: "#f87171", //        --destructive        oklch(0.704 0.191 22.216)   red-400
  ring: "#6b7280", //               --ring               oklch(0.551 0.027 264.364)  gray-500
  border: "rgba(255, 255, 255, 0.1)", // --border        oklch(1 0 0 / 10%)
  input: "rgba(255, 255, 255, 0.15)", // --input         oklch(1 0 0 / 15%)
} as const;

/** The panels sit inside ConnectCard, which is `bg-card`, so the iframe
 *  background is the card and not the page. */
export const DARK_VARIABLES = {
  colorBackground: DARK.card,
  colorText: DARK.foreground,
  colorSecondaryText: DARK.mutedForeground,
  colorBorder: DARK.border,
  colorPrimary: DARK.primary,
  colorDanger: DARK.destructive,
  offsetBackgroundColor: DARK.secondary,
  overlayBackdropColor: "rgba(0, 0, 0, 0.6)",

  actionPrimaryColorText: DARK.primary,
  actionSecondaryColorText: DARK.mutedForeground,

  // ui/button.tsx: default is bg-primary/text-primary-foreground, secondary is
  // bg-secondary/text-secondary-foreground, destructive is bg-destructive.
  buttonPrimaryColorBackground: DARK.primary,
  buttonPrimaryColorBorder: DARK.primary,
  buttonPrimaryColorText: DARK.primaryForeground,
  buttonSecondaryColorBackground: DARK.secondary,
  buttonSecondaryColorBorder: DARK.input,
  buttonSecondaryColorText: DARK.foreground,
  buttonDangerColorBackground: DARK.destructive,
  buttonDangerColorBorder: DARK.destructive,
  buttonDangerColorText: DARK.foreground,

  // Badges: the neutral one is ui/badge.tsx's secondary. Success, warning and
  // danger have no app token, so they are Tailwind's 950 step of green, amber
  // and red as the fill, 300 as the text and 800 as the border.
  badgeNeutralColorBackground: DARK.secondary,
  badgeNeutralColorText: DARK.foreground,
  badgeNeutralColorBorder: DARK.border,
  badgeSuccessColorBackground: "#052e16", // green-950
  badgeSuccessColorText: "#86efac", //       green-300
  badgeSuccessColorBorder: "#166534", //     green-800
  badgeWarningColorBackground: "#451a03", // amber-950
  badgeWarningColorText: "#fcd34d", //       amber-300
  badgeWarningColorBorder: "#92400e", //     amber-800
  badgeDangerColorBackground: "#450a0a", //  red-950
  badgeDangerColorText: "#fca5a5", //        red-300
  badgeDangerColorBorder: "#991b1b", //      red-800

  // ui/input.tsx is transparent over the card with a --input border.
  formBackgroundColor: DARK.card,
  formHighlightColorBorder: DARK.ring,
  formAccentColor: DARK.primary,
  formPlaceholderTextColor: DARK.mutedForeground,
} satisfies AppearanceVariables;

export function connectAppearanceFor({
  dark,
  coarse,
}: {
  dark: boolean;
  coarse: boolean;
}): AppearanceOptions {
  return {
    variables: {
      ...(dark ? DARK_VARIABLES : {}),
      ...(coarse ? COARSE_POINTER_VARIABLES : {}),
    },
  };
}
