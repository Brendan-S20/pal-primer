// The client page as a technician sees it: what they need at the door, and
// nothing they cannot act on. Opened from a stop's "Client info" on My Day, so
// it speaks the tech's language like the rest of their day (lib/i18n, and
// tests/support/tech-screens.ts). What the office typed (names, addresses,
// notes, breeds) is shown as written, in <bdi> so it keeps its own direction
// on an Arabic page; codes and phone numbers are always left to right.

import { Fragment, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { pageTitle, useDocumentTitle } from "@/lib/page-title";

/** The property flags a tech is warned about, in the order they are listed.
 *  Worded by `hazard.<flag>`, the same words as the stop card on My Day. */
const HAZARD_FLAGS = [
  "aggressive_dog",
  "dog_in_yard_during_service",
  "escape_risk",
  "invisible_fence",
  "bees_wasps",
  "sharp_objects",
  "slippery_surfaces",
  "do_not_enter_if_dog_out",
] as const;

/** Temperaments the app writes, worded by `dog.<temperament>`. */
const DOG_TEMPERAMENTS = new Set(["friendly", "nervous", "aggressive", "unknown"]);

/** The sizes the office's dog form offers, worded by `fieldClient.dogSize.<size>`.
 *  weight_class is free text (an import keeps whatever it was given), so
 *  anything else is shown as the office wrote it. */
const DOG_SIZES = new Set(["small", "medium", "large", "giant", "xlarge"]);

export function FieldClientView({
  client,
  properties,
  dogs,
  grooming = false,
}: {
  client: any;
  properties: any[];
  dogs: any[];
  grooming?: boolean;
}) {
  const { t } = useTranslation();
  useDocumentTitle(
    pageTitle(client.display_name ?? t("visit.fallbackClient"), t("fieldClient.pageSection")),
  );
  const dogsByProperty = new Map<string, any[]>();
  for (const dog of dogs) {
    const list = dogsByProperty.get(dog.property_id) ?? [];
    list.push(dog);
    dogsByProperty.set(dog.property_id, list);
  }

  const flagsFor = (p: any) =>
    HAZARD_FLAGS.filter((flag) => p[flag]).map((flag) => t(`hazard.${flag}`));

  const dogDetails = (d: any): ReactNode[] => {
    const parts: ReactNode[] = [];
    if (d.breed) parts.push(<bdi>{d.breed}</bdi>);
    if (d.weight_class) {
      const size = String(d.weight_class).toLowerCase();
      parts.push(
        DOG_SIZES.has(size) ? t(`fieldClient.dogSize.${size}`) : <bdi>{d.weight_class}</bdi>,
      );
    }
    if (grooming && d.coat_type) parts.push(t(`fieldClient.coatType.${d.coat_type}`));
    if (d.temperament) {
      parts.push(
        DOG_TEMPERAMENTS.has(d.temperament) ? (
          t(`dog.${d.temperament}`)
        ) : (
          <bdi>{d.temperament}</bdi>
        ),
      );
    }
    return parts;
  };

  return (
    <div className="space-y-4">
      <Link
        to="/my-day"
        className="inline-flex items-center text-sm text-muted-foreground hover:underline touch:min-h-11"
      >
        {t("fieldClient.backToMyDay")}
      </Link>

      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase text-muted-foreground">
          {t("fieldClient.heading")}
        </p>
        <h1 className="text-2xl font-bold tracking-tight">
          <bdi>{client.display_name}</bdi>
        </h1>
        {client.primary_phone && (
          <a
            className="inline-flex items-center text-sm font-medium underline touch:min-h-11"
            href={`tel:${client.primary_phone}`}
          >
            <span dir="ltr">{client.primary_phone}</span>
          </a>
        )}
        {client.notes && (
          <p className="whitespace-pre-wrap text-sm">
            <bdi>{client.notes}</bdi>
          </p>
        )}
      </header>

      {properties.map((p) => {
        const dogRows = dogsByProperty.get(p.id) ?? [];
        const flags = flagsFor(p);
        const place = [p.city, p.region, p.postal_code].filter(Boolean).join(" ");
        return (
          <section key={p.id} className="space-y-3 border-t pt-4">
            <div>
              <h2 className="text-lg font-semibold">
                {p.street || p.label ? (
                  <bdi>{p.street || p.label}</bdi>
                ) : (
                  t("fieldClient.propertyFallback")
                )}
              </h2>
              <p className="text-sm text-muted-foreground">{place && <bdi>{place}</bdi>}</p>
            </div>

            {(p.gate_code || p.lock_box_code || p.key_location) && (
              <div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-2">
                {p.gate_code && (
                  <div>
                    <span className="text-muted-foreground">{t("fieldClient.gate")}</span>{" "}
                    <span dir="ltr" className="font-mono">
                      {p.gate_code}
                    </span>
                  </div>
                )}
                {p.lock_box_code && (
                  <div>
                    <span className="text-muted-foreground">{t("fieldClient.lockBox")}</span>{" "}
                    <span dir="ltr" className="font-mono">
                      {p.lock_box_code}
                    </span>
                  </div>
                )}
                {p.key_location && (
                  <div className="sm:col-span-2">
                    <span className="text-muted-foreground">{t("fieldClient.key")}</span>{" "}
                    <bdi>{p.key_location}</bdi>
                  </div>
                )}
              </div>
            )}

            {(p.parking_notes || p.access_notes || p.hazard_notes || flags.length > 0) && (
              <div className="space-y-2 text-sm">
                {p.parking_notes && (
                  <p>
                    <span className="font-medium">{t("fieldClient.parking")}</span>{" "}
                    <bdi>{p.parking_notes}</bdi>
                  </p>
                )}
                {p.access_notes && (
                  <p>
                    <span className="font-medium">{t("fieldClient.access")}</span>{" "}
                    <bdi>{p.access_notes}</bdi>
                  </p>
                )}
                {flags.length > 0 && (
                  <p>
                    <span className="font-medium">{t("fieldClient.hazards")}</span>{" "}
                    {flags.join(t("fieldClient.listSeparator"))}
                  </p>
                )}
                {p.hazard_notes && (
                  <p className="whitespace-pre-wrap">
                    <bdi>{p.hazard_notes}</bdi>
                  </p>
                )}
              </div>
            )}

            <div>
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                {dogRows.some((d) => d.species && d.species !== "dog")
                  ? t("fieldClient.petsHeading", { number: dogRows.length })
                  : t("fieldClient.dogsHeading", { number: dogRows.length })}
              </h3>
              {dogRows.length ? (
                <ul className="mt-1 space-y-2">
                  {dogRows.map((d) => {
                    const details = dogDetails(d);
                    const species =
                      d.species === "cat" ? (
                        t("sit.species.cat")
                      ) : d.species === "other" ? (
                        d.species_note ? (
                          <bdi>{d.species_note}</bdi>
                        ) : (
                          t("sit.species.other")
                        )
                      ) : null;
                    return (
                      <li key={d.id} className="rounded-md border p-2 text-sm">
                        <div className="font-medium">
                          {d.name ? <bdi>{d.name}</bdi> : t("dog.fallbackName")}
                          {species && (
                            <span className="ms-2 font-normal text-muted-foreground">
                              {species}
                            </span>
                          )}
                        </div>
                        {d.vaccine_status && (
                          <span className="inline-block rounded-md border px-2 py-1 text-xs">{t(`vaccineStatus.${d.vaccine_status}`)}</span>
                        )}
                        {details.length > 0 && (
                          <div className="text-xs text-muted-foreground">
                            {details.map((part, i) => (
                              <Fragment key={i}>
                                {i > 0 && " · "}
                                {part}
                              </Fragment>
                            ))}
                          </div>
                        )}
                        {d.notes && (
                          <p className="mt-1 whitespace-pre-wrap text-xs">
                            <bdi>{d.notes}</bdi>
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">{t("fieldClient.noDogs")}</p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
