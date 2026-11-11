// Reader setup progress (Apple's review guide 3.9.1 and 5.7). The first time a
// phone becomes a reader, and after some iOS updates, Apple configures it,
// which can take a minute or two. The plugin reports that through
// ReaderSoftwareUpdateProgress; this draws it as a meter, so the person sees
// work happening rather than a button that says "Getting ready" forever.
import { useEffect, useState, type CSSProperties } from "react";
import { onReaderSetupProgress, type ReaderSetupProgress } from "@/lib/tap-to-pay-terminal";

export function useReaderSetupProgress(): ReaderSetupProgress {
  const [p, setP] = useState<ReaderSetupProgress>({ stage: "idle" });
  useEffect(() => onReaderSetupProgress(setP), []);
  return p;
}

export function TapToPayProgress({ progress }: { progress: ReaderSetupProgress }) {
  if (progress.stage === "idle" || progress.stage === "ready") return null;
  const percent = progress.stage === "updating" ? progress.percent : null;
  return (
    <div className="mt-2" data-testid="tap-to-pay-progress">
      <p className="text-xs font-medium" aria-live="polite">
        {percent === null
          ? "Setting up Tap to Pay on this phone…"
          : `Configuring this phone: ${percent}%`}
      </p>
      <div
        role="progressbar"
        aria-label="Tap to Pay setup"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`hs-meter h-full bg-primary${percent === null ? " animate-pulse" : ""}`}
          style={{ "--hs-meter": `${percent ?? 15}%` } as CSSProperties}
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        This can take a minute the first time. Keep the app open.
      </p>
    </div>
  );
}
