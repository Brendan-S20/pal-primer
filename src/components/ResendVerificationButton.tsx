import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { sendEmailVerification } from "@/lib/auth-entry.functions";

/** Sends the email verification link through the one path the app has for it
 *  (sendEmailVerification), on a tap. Payments and setup step 6 share it. */
export function ResendVerificationButton({
  label = "Resend verification email",
  variant = "outline",
}: {
  label?: string;
  variant?: "outline" | "default";
}) {
  const sendFn = useServerFn(sendEmailVerification);
  const m = useMutation({
    mutationFn: () => sendFn(),
    onSuccess: () => toast.success("Verification email sent. Check your inbox"),
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Button variant={variant} size="sm" onClick={() => m.mutate()} disabled={m.isPending}>
      {m.isPending ? "Sending…" : label}
    </Button>
  );
}
