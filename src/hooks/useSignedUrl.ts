import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/** Signed URL for an object in a private storage bucket (I3: one signing
 * implementation — visit photos, waste receipts, DNA sample photos all use
 * this instead of hand-rolling the createSignedUrl effect). */
export function useSignedUrl(
  bucket: string,
  path: string | null | undefined,
  ttlSeconds = 300,
): { url: string | null; status: "loading" | "ready" | "error" } {
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    if (!path) {
      setUrl(null);
      setStatus("error");
      return;
    }
    let cancelled = false;
    setUrl(null);
    setStatus("loading");
    supabase.storage
      .from(bucket)
      .createSignedUrl(path, ttlSeconds)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data?.signedUrl) {
          setStatus("error"); // object missing / signing failed
        } else {
          setUrl(data.signedUrl);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [bucket, path, ttlSeconds]);
  return { url, status };
}
