// Merchant education for Tap to Pay on iPhone (Apple's review guide 4.1, 4.2,
// 4.5, 4.6, 4.7), reopenable from Payments, Settings and from the pay form
// (4.3). On iOS 18 and later Apple's own guide (ProximityReaderDiscovery,
// through the app's local TapToPayEducation plugin) is offered first; these
// screens cover the rest, PIN entry included, and are what an older iPhone
// or an Android phone sees.
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TapToPayFullScreen } from "@/components/tap-to-pay/TapToPayFullScreen";
import { TapToPayMark } from "@/components/tap-to-pay/TapToPayMark";
import { TAP_TO_PAY_ON_IPHONE, tapToPayLabel } from "@/lib/tap-to-pay";

/** The education pages, in order. Exported so the copy is pinned by tests. */
export function educationPages(platform: string) {
  const name = tapToPayLabel(platform);
  const phone = platform === "ios" ? "iPhone" : "phone";
  return [
    {
      id: "how",
      title: `How to take a payment with ${name}`,
      body: [
        `Open an invoice and press ${name}. It is first in the payment options.`,
        `Hand the ${phone} to the client, or hold it facing them, with the screen up.`,
        `The client holds their card or their phone near the top of your ${phone} until they see Done.`,
      ],
    },
    {
      id: "cards",
      title: "Cards and wallets you can take",
      body: [
        "Contactless credit and debit cards. Look for the contactless symbol on the card.",
        "Apple Pay, Apple Watch and other digital wallets on a phone or watch.",
        "A card without the contactless symbol can't be tapped. Use New card to type it in instead.",
      ],
    },
    {
      id: "pin",
      title: "When the card asks for a PIN",
      body: [
        `Some cards ask for a PIN. The screen shows a PIN pad, and the client types their PIN on your ${phone}.`,
        "Turn the screen toward the client and look away while they type.",
        "Accessibility options are on the PIN screen for clients who need them, including VoiceOver.",
      ],
    },
    {
      id: "trouble",
      title: "If a tap doesn't work",
      body: [
        `Ask the client to hold the card still near the top of the ${phone}, and to take it out of a thick wallet or case.`,
        "If the card is declined, nothing is charged. Ask for another card.",
        "No signal means no approval. Move to where you have signal, or record a cash or check payment.",
      ],
    },
  ];
}

export function TapToPayEducation({
  platform,
  onClose,
}: {
  platform: string;
  onClose: () => void;
}) {
  const pages = educationPages(platform);
  const [i, setI] = useState(0);
  const [apple, setApple] = useState<null | (() => Promise<boolean>)>(null);
  useEffect(() => {
    if (platform !== "ios") return;
    let live = true;
    void import("@/lib/tap-to-pay-education-native").then(async (m) => {
      if (live && (await m.appleEducationAvailable())) setApple(() => m.showAppleEducation);
    });
    return () => {
      live = false;
    };
  }, [platform]);
  const page = pages[i];
  const last = i === pages.length - 1;
  return (
    <TapToPayFullScreen label={`How ${tapToPayLabel(platform)} works`} onClose={onClose}>
      <div className="flex flex-1 flex-col">
        <TapToPayMark className="h-12 w-12 text-primary" />
        <p className="mt-4 text-xs text-muted-foreground">
          {i + 1} of {pages.length}
        </p>
        <h2 className="mt-1 text-xl font-semibold">{page.title}</h2>
        <ul className="mt-4 space-y-3 text-sm">
          {page.body.map((line) => (
            <li key={line} className="leading-relaxed">
              {line}
            </li>
          ))}
        </ul>
        {i === 0 && apple && (
          <Button variant="outline" className="mt-6 h-11 w-full" onClick={() => void apple()}>
            Show Apple's guide to {TAP_TO_PAY_ON_IPHONE}
          </Button>
        )}
        <div className="mt-auto flex gap-3 pt-8">
          <Button
            variant="outline"
            className="h-11 flex-1"
            disabled={i === 0}
            onClick={() => setI((n) => Math.max(0, n - 1))}
          >
            <ChevronLeft className="me-1 h-4 w-4 shrink-0 rtl:rotate-180" />
            Back
          </Button>
          <Button className="h-11 flex-1" onClick={() => (last ? onClose() : setI((n) => n + 1))}>
            {last ? "Done" : "Next"}
            {!last && <ChevronRight className="ms-1 h-4 w-4 shrink-0 rtl:rotate-180" />}
          </Button>
        </div>
      </div>
    </TapToPayFullScreen>
  );
}
