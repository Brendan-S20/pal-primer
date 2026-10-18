// "Rate HoundStack" on Settings → Preferences (issue #508).
//
// A static row a person finds for themselves: it opens this app's page in the
// App Store or Google Play and nothing else. No prompt, no "do you like us",
// no incentive, which is why both stores allow it beside the timed review
// sheet in lib/rating-prompt-native.ts.
//
// iPhone and Android apps only. Nothing in the hosted app or the PWA:
// IS_NATIVE_BUNDLE folds to false there and takes the row with it, and
// isNative() is checked again at runtime, the way useRatingPrompt does.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Star } from "lucide-react";
import { Card } from "@/components/ui/card";
import { IS_NATIVE_BUNDLE } from "@/lib/native-build";
import { isNative, platform } from "@/lib/native";
import { rateAppUrl } from "@/lib/rating-prompt";

export function RateAppCard() {
  const { t } = useTranslation();
  const [os] = useState(() => (IS_NATIVE_BUNDLE && isNative() ? platform() : "web"));
  const url = IS_NATIVE_BUNDLE ? rateAppUrl(os) : null;
  if (!IS_NATIVE_BUNDLE || !url) return null;

  const open = async () => {
    // The same way the app opens every other outside page natively.
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
  };

  return (
    <Card>
      <button
        type="button"
        onClick={() => void open().catch(() => {})}
        className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl p-4 text-start sm:p-6"
      >
        <Star className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t("rateApp.title")}</span>
          <span className="block text-xs text-muted-foreground">
            {os === "ios" ? t("rateApp.ios") : t("rateApp.android")}
          </span>
        </span>
        <ChevronRight
          className="h-4 w-4 shrink-0 text-muted-foreground rtl:rotate-180"
          aria-hidden
        />
      </button>
    </Card>
  );
}
