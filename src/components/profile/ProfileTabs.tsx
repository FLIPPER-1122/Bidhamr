"use client";

import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { kanOptimeres } from "@/lib/billedUrl";
import AuctionCard, { type DummyAuction } from "@/components/AuctionCard";
import SettingsForm from "@/components/profile/SettingsForm";
import BedoemmelseListe from "@/components/profile/BedoemmelseListe";
import TomTilstand from "@/components/TomTilstand";
import type { BedoemmelseVisning } from "@/lib/bedoemmelser";
import { PROFIL_FANER, PROFIL_FANE_NAVN, type ProfilFane } from "@/lib/profilFaner";

export type BudStatus = "vinder" | "overbud" | "aktiv" | "pause";

export interface MitBud {
  auktionId: string;
  titel: string;
  billede: string | null;
  egetBud: number;
  højesteBud: number;
  status: BudStatus;
}

export interface EgenAuktion extends DummyAuction {
  slutterKl: string;
  status?: string;
  // Skjult af BidHamr og på pause (auctions.pauset_kl).
  pauset?: boolean;
}

// En modtaget bedømmelse med sælgerens svar (src/lib/bedoemmelserHent.ts).
export type Rating = BedoemmelseVisning;

const BUD_STYLE: Record<BudStatus, string> = {
  vinder: "bg-succes-bg text-succes-tekst",
  overbud: "bg-fejl-bg text-fejl-tekst",
  aktiv: "bg-kant text-tekst-daempet",
  pause: "bg-advarsel-bg text-advarsel-tekst",
};

const BUD_LABEL: Record<BudStatus, string> = {
  vinder: "Vinder",
  overbud: "Overbud",
  aktiv: "Aktiv",
  pause: "På pause",
};

function auktionStatusBadge(slutterKl: string, harBud: boolean, status?: string, pauset?: boolean) {
  if (status === "annulleret") return { label: "Annulleret", cls: "bg-kant text-tekst-daempet" };
  if (pauset) return { label: "På pause", cls: "bg-advarsel-bg text-advarsel-tekst" };
  const erSlut = new Date(slutterKl) <= new Date();
  if (!erSlut) return { label: "Aktiv", cls: "bg-succes-bg text-succes-tekst" };
  if (harBud) return { label: "Venter på betaling", cls: "bg-advarsel-bg text-advarsel-tekst" };
  return { label: "Afsluttet", cls: "bg-kant text-tekst-daempet" };
}

// Fanerne er almindelige links (?fane=...), så siden læser fanen på serveren,
// og "Mine handler" kun hentes, når den fane er åben.
export default function ProfileTabs({
  fane,
  handlerIndhold,
  egneAuktioner,
  mineBud,
  ratings,
  brugerId,
  navn,
  telefon,
  adresse = null,
  email,
  avatarUrl,
}: {
  fane: ProfilFane;
  // Fanen "Mine handler" (server-renderet MineHandlerListe), ellers null.
  handlerIndhold: ReactNode;
  egneAuktioner: EgenAuktion[];
  mineBud: MitBud[];
  ratings: Rating[];
  brugerId: string;
  navn: string;
  telefon: string | null;
  adresse?: string | null;
  email: string;
  avatarUrl: string | null;
}) {
  return (
    <div className="mt-6">
      {/* Fanebjælke: ruller vandret på smalle skærme. */}
      <nav aria-label="Min profil" className="-mx-4 overflow-x-auto border-b border-kant px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
        <ul className="flex gap-1">
          {PROFIL_FANER.map((key) => (
            <li key={key} className="shrink-0">
              <Link
                href={`?fane=${key}`}
                scroll={false}
                aria-current={fane === key ? "page" : undefined}
                className={`-mb-px flex min-h-11 items-center border-b-2 px-4 text-sm whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen ${
                  fane === key
                    ? "border-groen font-semibold text-groen"
                    : "border-transparent font-medium text-tekst-daempet hover:border-kant-staerk hover:text-tekst"
                }`}
              >
                {PROFIL_FANE_NAVN[key]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-6">
        {/* Mine auktioner */}
        {fane === "auktioner" && (
          egneAuktioner.length === 0 ? (
            <TomTilstand
              ikon="plus"
              titel="Du har ingen auktioner endnu"
              tekst="Sæt noget til salg på få minutter."
              knap={{ href: "/opret-auktion", tekst: "Opret din første auktion" }}
            />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
              {egneAuktioner.map((auktion) => {
                const badge = auktionStatusBadge(auktion.slutterKl, auktion.antalBud > 0, auktion.status, auktion.pauset);
                return (
                  <div key={auktion.id} className="relative">
                    <span
                      className={`absolute top-2 left-2 z-10 rounded-full px-2 py-0.5 text-xs font-semibold ${badge.cls}`}
                    >
                      {badge.label}
                    </span>
                    <AuctionCard auktion={auktion} />
                  </div>
                );
              })}
            </div>
          )
        )}

        {/* Mine bud */}
        {fane === "bud" && (
          mineBud.length === 0 ? (
            <TomTilstand
              ikon="ur"
              titel="Du har ikke budt endnu"
              tekst="Find noget, du kan lide, og giv dit første bud."
              knap={{ href: "/auktioner", tekst: "Se alle auktioner" }}
            />
          ) : (
            <ul className="divide-y divide-kant rounded-[14px] border border-kant bg-white">
              {mineBud.map((bud) => (
                <li key={bud.auktionId} className="relative flex items-center gap-3 px-4 py-3.5 sm:gap-4">
                  <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-skelet">
                    {bud.billede && (
                      <Image
                        src={bud.billede}
                        alt=""
                        fill
                        sizes="56px"
                        unoptimized={!kanOptimeres(bud.billede)}
                        className="object-cover"
                      />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    {/* Hele rækken er klikbar (after:inset-0), så touch-målet er stort. */}
                    <Link
                      href={`/auktion/${bud.auktionId}`}
                      className="block truncate rounded-md text-[15px] font-medium text-tekst after:absolute after:inset-0 hover:text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
                    >
                      {bud.titel}
                    </Link>
                    <p className="mt-0.5 text-[13px] text-tekst-svag">
                      Dit bud:{" "}
                      <span className="font-semibold text-tekst">
                        {bud.egetBud.toLocaleString("da-DK")} kr
                      </span>
                      {bud.højesteBud !== bud.egetBud && (
                        <>
                          {" "}· Højeste:{" "}
                          <span className="font-semibold text-tekst">
                            {bud.højesteBud.toLocaleString("da-DK")} kr
                          </span>
                        </>
                      )}
                    </p>
                  </div>

                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${BUD_STYLE[bud.status]}`}
                  >
                    {BUD_LABEL[bud.status]}
                  </span>
                </li>
              ))}
            </ul>
          )
        )}

        {/* Mine handler */}
        {fane === "handler" && handlerIndhold}

        {/* Bedømmelser */}
        {fane === "bedommelser" && (
          ratings.length === 0 ? (
            <TomTilstand
              ikon="bruger"
              titel="Ingen bedømmelser endnu"
              tekst="Når du har handlet, kan den anden part give dig en bedømmelse."
            />
          ) : (
            // Med "Svar fra sælger": ét offentligt svar pr. bedømmelse.
            <div className="space-y-3">
              <p className="text-sm text-tekst-svag">
                Du kan skrive ét offentligt svar på hver bedømmelse. Svaret kan rettes eller slettes i 48 timer.
              </p>
              <BedoemmelseListe
                ratings={ratings}
                erSaelger
                erLoggetInd
                mitId={brugerId}
                kortKlasse="rounded-[14px] border border-kant bg-white p-4 sm:p-5"
                tomTekst="Du har ingen bedømmelser endnu."
              />
            </div>
          )
        )}

        {/* Indstillinger */}
        {fane === "indstillinger" && (
          <SettingsForm
            brugerId={brugerId}
            navn={navn}
            telefon={telefon}
            adresse={adresse}
            email={email}
            avatarUrl={avatarUrl}
          />
        )}
      </div>
    </div>
  );
}
