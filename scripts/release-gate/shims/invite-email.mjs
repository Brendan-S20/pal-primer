// No email leaves the release gate. An invite that gets this far is recorded.
export async function sendInviteEmail(_orgName, email) {
  globalThis.__releaseGate.invitesSuppressed.push(email);
  return { email, sent: false };
}
