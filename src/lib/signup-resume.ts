// What a /get-started page drawn afresh partway through sign-up already has,
// beyond what the person typed (#882).
//
// ── WHAT WAS WRONG (onboarding QA, 2026-11-11) ────────────────────────────
//
// #785 kept the typed fields in sessionStorage so a reload could not wipe the
// form, and asked for the password once more on any step past the first,
// because the password is never kept. That was honest for a sign-up that had
// not created anything yet. It was wrong for one that HAD: "Create my
// workspace" registers the account and signs in first, then builds the
// business, and the signed-in session is stored by the Supabase client on
// this device. A reload in that window (the slow first submit #785 was about)
// came back to "Your password … it is asked for again after the page
// reloads", for an account that already existed and a session that was
// already signed in to it. How far the create had got lived only in a React
// ref, and nothing read the session back.
//
// So the session is the evidence: signed in, on this device, as the address
// the draft holds, means the account exists and the last step can carry on
// without a password. Anything else (no session, a different address, a
// session that could not be read in time) asks for it, as before, and says
// plainly that the account is not created yet.
//
// NEVER the password: nothing here reads, writes or keeps one.

/** How long to wait for the stored session before asking for the password.
 *  getSession() can refresh an expired token over the network first; a
 *  person on a weak signal is asked for the password rather than kept on a
 *  disabled button. */
export const RESUME_SESSION_DEADLINE_MS = 3_000;

export type SignupResume = {
  /** This device is signed in to the account the draft was creating. */
  signedIn: boolean;
  /** The last step needs the password typed again to finish. */
  askPassword: boolean;
};

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Decide what a restored draft needs, from the address it holds, the step it
 *  was on, and the address of the session on this device (if any). */
export function resumeSignup(
  draft: { email: string; step: number },
  sessionEmail: string | null | undefined,
): SignupResume {
  const signedIn = draft.step > 0 && same(draft.email, sessionEmail);
  return { signedIn, askPassword: draft.step > 0 && !signedIn };
}

type GetSession = () => Promise<{
  data: { session: { user?: { email?: string | null } | null } | null };
}>;

/** The email of the session stored on this device, or null: no session, a
 *  failure, or no answer within the deadline. Never throws. */
export async function readSessionEmail(
  getSession: GetSession,
  deadlineMs = RESUME_SESSION_DEADLINE_MS,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deadlineMs);
    });
    const read = getSession().then(
      (r) => r?.data?.session?.user?.email ?? null,
      () => null,
    );
    return await Promise.race([read, late]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Said on the last step when a create was interrupted after the account was
 *  made and signed in: nothing has to be typed again. */
export const SIGNUP_RESUMED_SIGNED_IN_MESSAGE =
  "Creating your workspace was interrupted before it finished. Your account is created and you are still signed in, so there is nothing to type again: press Try again to finish it.";
