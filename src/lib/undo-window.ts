// A change that is held for a few seconds before it is sent, so Undo can
// take it back before anybody else hears about it.
//
// Why held rather than sent and reversed: reassigning a visit tells two
// technicians (field-notify) and refreshes two lock screens the moment the
// server function returns. An Undo that reverses the write afterwards would
// leave both of them with a notification about a change that never stood.
// Holding the call means a dispatcher who picked the wrong name in a native
// select on a phone can take it back and nobody is told anything.
//
// The timer is not tied to a component. Closing the drawer inside the window
// still sends the change; only Undo cancels it. A page that is being hidden
// (tab closed, app sent to the background) sends everything still waiting,
// because a change the dispatcher saw applied must not quietly vanish.

export const UNDO_WINDOW_MS = 5_000;

export type HeldChange = {
  /** Cancel the change. False when it has already been sent. */
  undo: () => boolean;
  /** Send it now rather than at the end of the window. */
  flush: () => void;
  /** Settles once the change was sent (true) or undone (false). */
  done: Promise<boolean>;
};

const waiting = new Set<() => void>();
let listening = false;

function flushAllOnHide() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("pagehide", () => {
    for (const f of [...waiting]) f();
  });
}

/**
 * Run `send` after `ms`, unless `undo()` is called first.
 *
 * `send` runs at most once. An error it throws is passed to `onError` and
 * the returned `done` resolves to false, so a caller can put the screen back.
 */
export function holdForUndo(
  send: () => Promise<unknown>,
  {
    ms = UNDO_WINDOW_MS,
    onError,
  }: { ms?: number; onError?: (e: unknown) => void } = {},
): HeldChange {
  let state: "waiting" | "sent" | "undone" = "waiting";
  let settle!: (v: boolean) => void;
  const done = new Promise<boolean>((r) => (settle = r));

  const fire = () => {
    if (state !== "waiting") return;
    state = "sent";
    clearTimeout(timer);
    waiting.delete(fire);
    send().then(
      () => settle(true),
      (e) => {
        onError?.(e);
        settle(false);
      },
    );
  };

  const timer = setTimeout(fire, ms);
  waiting.add(fire);
  flushAllOnHide();

  return {
    undo: () => {
      if (state !== "waiting") return false;
      state = "undone";
      clearTimeout(timer);
      waiting.delete(fire);
      settle(false);
      return true;
    },
    flush: fire,
    done,
  };
}
