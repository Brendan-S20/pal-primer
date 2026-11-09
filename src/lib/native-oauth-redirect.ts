// The custom-scheme hand-back URL, on its own so a module can name it without
// importing lib/native-oauth.ts and, through it, the Supabase client.
//
// Must match CFBundleURLTypes in ios/App/App/Info.plist (and the intent
// filter in android/app/src/main/AndroidManifest.xml) AND be allow-listed in
// Supabase -> Authentication -> URL Configuration -> Redirect URLs. Supabase
// refuses to redirect anywhere that is not on that list, silently landing the
// person on the site URL instead, which looks like "the button did nothing".
export const NATIVE_OAUTH_REDIRECT = "consulting.thenorth.houndstack://auth-callback";
