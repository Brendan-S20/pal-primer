// "Download PDF", in the two shapes the app needs.
//
// DownloadPdfLink: a plain link to a public PDF route. Used on the customer's
// two token pages, where it has to work in whatever browser a texted link
// opened in, including in-app browsers that ignore a script-built download.
//
// DownloadPdfButton: calls a server function (which carries the office's
// bearer token or the portal's session) and saves the bytes it returns. From
// the native app a blob download goes nowhere (WKWebView has no downloads
// folder, Android's WebView drops it), so the native build writes the same
// bytes to the app's cache and opens the system share sheet, which has Save
// to Files / Drive, Print, Mail and every other app.
//
// It used to open the document's public PDF link in the system browser. That
// left the app for Chrome on Android, and the link was built from the
// production host whatever API the build talked to, so a dev or staging build
// sent local tokens to production (#660). The share sheet needs no link and no
// second host: the bytes come from the server function this build already
// calls.
//
// Both are ui/button, so both are on the 44px touch floor (`touch:min-h-11`)
// at every width, and neither sets a width, so a narrow row wraps them.
import { useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button, type ButtonProps } from "@/components/ui/button";
import { isNative } from "@/lib/native";
import { nativePdfName } from "@/lib/pdf-file-name";

type Common = {
  label?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
};

export function DownloadPdfLink({
  href,
  label = "Download PDF",
  variant = "outline",
  size,
  className,
}: Common & { href: string }) {
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <a href={href} download rel="noopener">
        <FileDown className="h-4 w-4 shrink-0" aria-hidden />
        {label}
      </a>
    </Button>
  );
}

function saveBase64Pdf(filename: string, base64: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a delay: Safari starts the download after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Native: write the PDF to the app's cache and open the share sheet. A
 *  dismissed sheet is not an error. */
async function shareNativePdf(filename: string, base64: string) {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import("@capacitor/filesystem"),
    import("@capacitor/share"),
  ]);
  const name = nativePdfName(filename);
  const { uri } = await Filesystem.writeFile({
    path: `pdf/${name}`,
    data: base64,
    directory: Directory.Cache,
    recursive: true,
  });
  try {
    await Share.share({ title: name, files: [uri], dialogTitle: name });
  } catch (e) {
    if (/cancel/i.test((e as Error)?.message ?? "")) return;
    throw e;
  }
}

export function DownloadPdfButton({
  load,
  label = "Download PDF",
  variant = "outline",
  size,
  className,
}: Common & {
  load: () => Promise<{ filename: string; base64: string }>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const file = await load();
          if (isNative()) await shareNativePdf(file.filename, file.base64);
          else saveBase64Pdf(file.filename, file.base64);
        } catch (e) {
          toast.error((e as Error).message || "The PDF could not be made. Please try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden />
      ) : (
        <FileDown className="h-4 w-4 shrink-0" aria-hidden />
      )}
      {busy ? "Preparing PDF…" : label}
    </Button>
  );
}
