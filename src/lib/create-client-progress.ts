/**
 * What the Create client button says while the request runs (#1011-3).
 *
 * The page makes ONE request, so it cannot see which step the server is on and
 * must not pretend to ("Saving… adding property… scheduling visits…" ticking
 * on a timer would be invented). What it can say truthfully is what that one
 * request does, from what is being sent: the client and property always, dogs
 * and a plan when they were entered (a plan also schedules its visits), and,
 * once it has been a while, that it is still going and safe to wait for.
 */
export function createClientProgress(args: {
  hasDogs: boolean;
  hasPlan: boolean;
  secondsWaited: number;
}): { button: string; detail: string } {
  const parts = ["the client", "the property"];
  if (args.hasDogs) parts.push("their dogs");
  if (args.hasPlan) parts.push("the plan and its visits");
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  const detail =
    args.secondsWaited >= 6
      ? `Still saving ${list}. Scheduling visits can take up to 15 seconds. Please keep this page open.`
      : `Saving ${list}.`;
  return { button: "Creating…", detail };
}
