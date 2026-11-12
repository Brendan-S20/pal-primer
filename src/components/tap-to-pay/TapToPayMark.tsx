// The Tap to Pay button icon (Apple's review guide 5.5): the SF Symbol
// `wave.3.right.circle`, a circle holding three contactless waves. A web view
// cannot draw SF Symbols, so this is that symbol as SVG, drawn on a 24 grid
// in currentColor. To use Apple's exported symbol instead, replace the paths
// with the SVG the SF Symbols app exports for wave.3.right.circle.
// Never the Apple logo, which the guide does not allow on the button.
import { TAP_TO_PAY_SF_SYMBOL } from "@/lib/tap-to-pay";

export function TapToPayMark({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      data-sf-symbol={TAP_TO_PAY_SF_SYMBOL}
      className={`${className} shrink-0`}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M8.6 9.4a3.7 3.7 0 0 1 0 5.2" />
      <path d="M11.2 7.6a6.2 6.2 0 0 1 0 8.8" />
      <path d="M13.8 5.8a8.7 8.7 0 0 1 0 12.4" />
    </svg>
  );
}
