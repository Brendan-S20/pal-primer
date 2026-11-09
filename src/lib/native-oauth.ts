// Signing in with a provider from inside the iOS binary.
//
// ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────
//
// The web flow navigates the page to the provider and lets the provider
// navigate back. Inside a Capacitor app that cannot work, for two separate
// reasons that are easy to conflate:
//
//   Google REFUSES OAuth in an embedded WebView -- `disallowed_useragent` --
//   and the app's WKWebView is one. This is a policy refusal, not a bug, and
//   no amount of wiring gets around it.
//
//   Even if it did, the redirect would land back in a browser context that is
//   not the app, and the session would be created somewhere the app cannot
//   read.
//
// Both are solved the same way: open the provider in the SYSTEM browser, and
// have it hand back to the app through a custom URL scheme.
//
// `@capacitor/browser` opens SFSafariViewController on iOS. That is the
// distinction that matters to Google: SFSafariViewController and
// ASWebAuthenticationSession are approved system browsers, an in-app WKWebView
// is not. So Google works here and cannot work in the shell.
//
// ── WHY IMPLICIT AND NOT PKCE ────────────────────────────────────────────
//
// PKCE is the better flow for a mobile app and this deliberately does not use
// it. `flowType` is a property of the ONE shared Supabase client, and setting
// it to 'pkce' changes the shape of every email link the product sends:
// confirmation and password reset arrive as `?code=` instead of
// `#access_token=`. That is a live regression on the web for a security
// improvement on native, taken at the end of a submission checklist.
//
// So: implicit, tokens arrive in the fragment of the deep link, and setSession
// puts them where the rest of the app already looks. If this is ever revisited,
// the honest fix is a second client configured for native rather than flipping
// the shared one.
import { supabase } from "@/integrations/supabase/client";

export type OAuthProvider = "google" | "apple" | "facebook";

import { NATIVE_OAUTH_REDIRECT } from "@/lib/native-oauth-redirect";
// Re-exported: callers have always imported it from here. Its definition, and
// why it must match Info.plist and Supabase's allow-list, is in that file.
export { NATIVE_OAUTH_REDIRECT };

/** Start the flow: ask Supabase for the provider URL, then open it OUTSIDE the
 *  app. `skipBrowserRedirect` is what stops supabase-js navigating the WebView
 *  itself, which is the whole problem this file exists to avoid. */
export async function nativeOAuthSignIn(provider: OAuthProvider): Promise<void> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: NATIVE_OAUTH_REDIRECT, skipBrowserRedirect: true },
  });
  if (error) throw new Error(error.message);
  if (!data?.url) throw new Error("Supabase did not return a sign-in URL for that provider.");

  const { Browser } = await import("@capacitor/browser");
  await Browser.open({ url: data.url });
}

type CallbackResult = { ok: true } | { ok: false; message: string };

/**
 * Handle the hand-back. Returns null for a URL that is not ours, so the caller
 * can keep listening for other deep links.
 */
export async function completeNativeOAuth(url: string): Promise<CallbackResult | null> {
  if (!url.startsWith(NATIVE_OAUTH_REDIRECT)) return null;

  const { Browser } = await import("@capacitor/browser");
  // Close first. If anything below throws, a Safari sheet left open over the
  // app is a dead end a person cannot get out of without force-quitting.
  await Browser.close().catch(() => {});

  // Implicit flow puts the tokens in the FRAGMENT, and errors can arrive in
  // either half depending on where the refusal happened -- the provider uses
  // the query string, Supabase uses the fragment.
  const hash = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1).split("#")[0] : "";
  const params = new URLSearchParams(hash);
  const queryParams = new URLSearchParams(query);

  const err = params.get("error_description") ?? queryParams.get("error_description");
  const errCode = params.get("error") ?? queryParams.get("error");
  if (err || errCode) {
    return { ok: false, message: err ?? errCode ?? "Sign-in was canceled." };
  }

  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  if (!access_token || !refresh_token) {
    // The commonest cause by far is the redirect URL not being allow-listed in
    // Supabase, which sends the person to the site URL with no tokens at all.
    return {
      ok: false,
      message:
        "That sign-in did not come back with a session. Check that " +
        `${NATIVE_OAUTH_REDIRECT} is in Supabase's redirect allow-list.`,
    };
  }

  const { error } = await supabase.auth.setSession({ access_token, refresh_token });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

// ── SIGN IN WITH APPLE, WITH NO BROWSER AT ALL ───────────────────────────
//
// Google and Facebook have to leave the app: Google refuses OAuth in an
// embedded WebView and there is no way round it. Apple does not. ASAuthorization
// is a system sheet -- Face ID, two taps, no Safari -- and it is what an iOS
// user expects from an Apple button.
//
// The flow is different in kind, not degree. There is no redirect and no URL to
// come back from: the sheet returns an identity token and Supabase exchanges it
// directly.
//
// ── THE NONCE, WHICH IS EASY TO GET SUBTLY WRONG ─────────────────────────
//
// Apple binds the token to a nonce, and the two ends want DIFFERENT forms of
// it: Apple is given the SHA-256 hash, and Supabase is given the raw string it
// hashes to. Sending the same value to both looks like it works -- the sheet
// appears, the token comes back -- and Supabase rejects it with a message about
// the nonce that reads like a library problem.
export async function nativeAppleSignIn(): Promise<void> {
  const raw = crypto.randomUUID() + crypto.randomUUID();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hashed = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const { SignInWithApple } = await import("@capacitor-community/apple-sign-in");
  const result = await SignInWithApple.authorize({
    clientId: "consulting.thenorth.houndstack",
    redirectURI: NATIVE_OAUTH_REDIRECT,
    scopes: "email name",
    nonce: hashed,
  });

  const token = result?.response?.identityToken;
  if (!token) throw new Error("Apple did not return an identity token.");

  const { error } = await supabase.auth.signInWithIdToken({
    provider: "apple",
    token,
    nonce: raw,
  });
  if (error) throw new Error(error.message);
}
