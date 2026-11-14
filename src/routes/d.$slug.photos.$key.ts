import { createFileRoute } from "@tanstack/react-router";

// GET /d/{directory slug}/photos/{key} (#630; directory v2 step 5b)
//
// The public URL of a directory photo, as directory_public_listings.photos
// gives it. It answers with the image only while the photo is APPROVED and
// its listing is published by a live business; anything else is a 404. The
// photo lives in a PRIVATE bucket and its storage path never leaves the
// server: see servePublicDirectoryPhoto in lib/directory-photos.functions.ts.
// Under /d, which stays in the browser on Android (lib/android-app-links.ts).
export const Route = createFileRoute("/d/$slug/photos/$key")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { servePublicDirectoryPhoto } = await import("@/lib/directory-photos.functions");
        return servePublicDirectoryPhoto(params.slug, params.key);
      },
    },
  },
});
