// A client's groom request in the Concerns inbox: the pet, the groom, the
// add-ons, the day and window they prefer, and the price and length the
// portal showed. "Book this groom" opens the office's booking dialog with
// those values; the office picks the start time and the groomer. Decline
// resolves the request with a note the client reads in the portal.

import { CalendarCheck, Scissors } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { formatDay } from "@/lib/format";
import { groomWindowOf } from "@/lib/groom-request";

/** What the client reads when the office declines without writing its own.
 *  English on purpose: it is sent to the customer, in the business's words. */
export const GROOM_DECLINE_NOTE =
  "We couldn't fit that day in. Please pick another day, or give us a call.";

function oneOf<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The columns of a listConcerns row this row reads. */
export type GroomConcern = {
  booked_visit?: unknown;
  service?: unknown;
  dog?: unknown;
  requested_on: string | null;
  requested_time: string | null;
  requested_time_end: string | null;
  groom_addons: unknown;
  quoted_cents: number | null;
  quoted_minutes: number | null;
  property_id: string | null;
  dog_id: string | null;
};

export function GroomRequestRow({
  concern,
  resolved,
  canBook,
  awaitingLink,
  addonNames,
  onBook,
  onLink,
  onDecline,
  busy,
}: {
  concern: GroomConcern;
  resolved: boolean;
  canBook: boolean;
  /** A groom was booked for this request but the link failed: retry the link
   *  rather than book a second groom. */
  awaitingLink: boolean;
  addonNames: Record<string, string>;
  onBook: () => void;
  onLink: () => void;
  onDecline: () => void;
  busy: boolean;
}) {
  const { t, i18n } = useTranslation();
  const booked = oneOf(concern.booked_visit as { scheduled_on: string } | null | undefined);
  const service = oneOf(concern.service as { name: string } | null | undefined);
  const dog = oneOf(concern.dog as { name: string } | null | undefined);
  const asked = groomWindowOf(concern.requested_time, concern.requested_time_end);
  const windowLabel = t(asked === "any" ? "groomRequest.anyTime" : `groomRequest.${asked}`);
  const day = formatDay(concern.requested_on, i18n.language);
  const addons = (
    (Array.isArray(concern.groom_addons) ? concern.groom_addons : []) as Array<{
      addon_service_id: string;
      quantity: number;
    }>
  )
    .map((a) => {
      const name = addonNames[a.addon_service_id];
      if (!name) return null;
      return a.quantity > 1 ? `${name} x${a.quantity}` : name;
    })
    .filter(Boolean) as string[];

  return (
    <div className="mt-3 space-y-2 rounded-md border border-fuchsia-500/40 bg-fuchsia-500/10 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {booked ? (
          <CalendarCheck className="h-4 w-4 shrink-0 text-fuchsia-700 dark:text-fuchsia-400" />
        ) : (
          <Scissors className="h-4 w-4 shrink-0 text-fuchsia-700 dark:text-fuchsia-400" />
        )}
        <span className="min-w-0 flex-1 basis-48 break-words text-fuchsia-900 dark:text-fuchsia-200">
          {booked
            ? t("groomRequest.booked", { day: formatDay(booked.scheduled_on, i18n.language) })
            : resolved
              ? t("groomRequest.notBooked", { day })
              : t("groomRequest.asked", {
                  service: service?.name ?? t("groomRequest.aGroom"),
                  pet: dog?.name ?? t("groomRequest.aPet"),
                  day,
                  window: windowLabel,
                })}
        </span>
      </div>
      {!booked && !resolved && (
        <div className="space-y-1 text-xs text-fuchsia-900/80 dark:text-fuchsia-200/80">
          {addons.length > 0 && (
            <p className="break-words">{t("groomRequest.addons", { list: addons.join(", ") })}</p>
          )}
          {concern.quoted_minutes != null && (
            <p>
              {concern.quoted_cents != null
                ? t("groomRequest.quote", {
                    price: money(concern.quoted_cents),
                    minutes: concern.quoted_minutes,
                  })
                : t("groomRequest.noPrice", { minutes: concern.quoted_minutes })}
            </p>
          )}
        </div>
      )}
      {!booked && !resolved && canBook && (
        <div className="flex flex-wrap justify-end gap-2">
          {awaitingLink ? (
            <Button size="sm" disabled={busy} onClick={onLink}>
              {t("groomRequest.link")}
            </Button>
          ) : (
            <>
              <ConfirmButton
                title={t("groomRequest.declineTitle")}
                description={t("groomRequest.declineBody", { note: GROOM_DECLINE_NOTE })}
                confirmLabel={t("groomRequest.decline")}
                onConfirm={onDecline}
                trigger={
                  <Button size="sm" variant="outline" disabled={busy}>
                    {t("groomRequest.decline")}
                  </Button>
                }
              />
              <Button
                size="sm"
                disabled={busy || !concern.property_id || !concern.dog_id}
                onClick={onBook}
              >
                {t("groomRequest.book")}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
