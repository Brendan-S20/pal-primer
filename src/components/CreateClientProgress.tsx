import { useEffect, useState } from "react";
import { createClientProgress } from "@/lib/create-client-progress";

/** The line under Create client while it saves. See lib/create-client-progress.ts. */
export function CreateClientProgress({ hasDogs, hasPlan }: { hasDogs: boolean; hasPlan: boolean }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const { detail } = createClientProgress({ hasDogs, hasPlan, secondsWaited: seconds });
  return (
    <p
      role="status"
      aria-live="polite"
      data-create-client-progress=""
      className="max-w-xs text-right text-xs text-muted-foreground"
    >
      {detail}
    </p>
  );
}
