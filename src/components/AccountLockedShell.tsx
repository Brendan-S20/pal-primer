// What a locked account sees (NP-12): this notice, and Plan & billing beneath it
// for somebody who can choose a plan. Nothing else of the workspace is drawn,
// because nothing else would load: the server refuses every other function
// (src/lib/account-lock.server.ts).
//
// The words are the banner's own (TRIAL_COPY), so the lock and the banner
// cannot say two different things.
import type { CSSProperties, ReactNode } from "react";
import { Lock } from "lucide-react";
import { AccountMenu } from "@/components/AccountMenu";
import { PageShell } from "@/components/PageShell";
import { nativeTopBarStyle } from "@/lib/native-build";
import { TRIAL_COPY } from "@/lib/trial";
import { nonOwnerLockedNotice, type AccountLockReason } from "@/lib/account-lock";

export function AccountLockedShell({
  reason,
  canChoosePlan,
  onSignOut,
  style,
  children,
}: {
  reason: AccountLockReason;
  canChoosePlan: boolean;
  onSignOut: () => void;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const copy = reason === "plan_ended" ? TRIAL_COPY.lapsed : TRIAL_COPY.expired;
  return (
    <div className="flex min-h-screen w-full flex-col bg-background" style={style}>
      <header
        style={nativeTopBarStyle(3.5)}
        className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b bg-card/80 pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] backdrop-blur"
      >
        <span className="min-w-0 truncate font-semibold">HoundStack</span>
        <AccountMenu onSignOut={onSignOut} />
      </header>
      <div
        role="status"
        data-account-locked={reason}
        className="flex items-start gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
      >
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0">
          {canChoosePlan ? (
            <>
              <p className="font-medium">{copy.headline({} as never)}</p>
              <p>{copy.body}</p>
            </>
          ) : (
            // Somebody who cannot subscribe gets one line that says whose move
            // it is (Brendan, 2026-11-09). Nothing of the workspace is drawn
            // beneath it: no routes, no visits, no Take payment.
            <p className="font-medium" data-testid="non-owner-locked-notice">
              {nonOwnerLockedNotice(reason)}
            </p>
          )}
        </div>
      </div>
      <main className="min-w-0 flex-1 pb-[calc(2rem+env(safe-area-inset-bottom))]">
        <PageShell width="standard">{canChoosePlan ? children : null}</PageShell>
      </main>
    </div>
  );
}
