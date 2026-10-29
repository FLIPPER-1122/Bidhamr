import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { kanOptimeres } from "@/lib/billedUrl";
import MitIDMaerke from "@/components/mitid/MitIDMaerke";
import PopulaerSaelgerMaerke from "@/components/PopulaerSaelgerMaerke";
import FoundingSellerMaerke from "@/components/FoundingSellerMaerke";
import Ikon from "@/components/Ikon";
import { mitIdStartHref } from "@/components/mitid/MitIDKraeves";
import { MITID } from "@/lib/tekster/mitid";

interface ProfileHeaderProps {
  navn: string;
  email?: string;
  avatarUrl: string | null;
  medlemSiden: string;
  gennemsnitRating: number;
  antalRatings: number;
  stats: {
    auktionerOprettet: number;
    budAfgivet: number;
    gennemforteHandler: number;
  };
  erEgenProfil: boolean;
  brugerId: string;
  // Antal følgere er offentligt (HVEM der følger er ikke).
  antalFoelgere?: number;
  // Fx "Følg"-knappen på en andens profil.
  handling?: ReactNode;
  // users.mitid_verificeret_kl er sat: mærket "MitID-verificeret".
  mitidVerificeret?: boolean;
  // Kun på egen profil: ejeren er ikke MitID-verificeret (vises aldrig for andre).
  mitidManglerEjer?: boolean;
  // Mindst 50 gennemførte salg: mærket "Populær sælger" (offentligt).
  populaerSaelger?: boolean;
  // Aktiv seller founder: mærket "Founding seller" (offentligt).
  foundingSeller?: boolean;
}

export default function ProfileHeader({
  navn,
  email,
  avatarUrl,
  medlemSiden,
  gennemsnitRating,
  antalRatings,
  stats,
  erEgenProfil,
  brugerId,
  antalFoelgere,
  handling,
  mitidVerificeret = false,
  mitidManglerEjer = false,
  populaerSaelger = false,
  foundingSeller = false,
}: ProfileHeaderProps) {
  return (
    <div className="overflow-hidden rounded-none border border-kant bg-white">
      <div className="px-5 pb-6 pt-6 sm:px-8">
        {/* Avatar, navn, oplysninger og knap. Mobil: avatar og navn side om
            side, oplysninger og knap i fuld bredde under. Fra sm: avatar til
            venstre, knappen til højre. Knappen renderes kun én gang. */}
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-x-5 sm:gap-y-2">
          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full border border-kant bg-groen-lys col-start-1 row-start-1 sm:row-span-2 sm:h-24 sm:w-24 sm:self-start">
            {avatarUrl ? (
              <Image
                src={avatarUrl}
                alt=""
                fill
                sizes="96px"
                unoptimized={!kanOptimeres(avatarUrl)}
                className="object-cover"
              />
            ) : (
              <svg
                viewBox="0 0 24 24"
                className="h-full w-full p-4 text-groen-mork sm:p-5"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"
                />
              </svg>
            )}
          </div>

          <div className="col-start-2 row-start-1 min-w-0 sm:self-end">
            <h1 className="min-w-0 text-[26px] leading-tight break-words sm:text-[32px]">
              {navn}
            </h1>
            {email && (
              <p className="mt-0.5 text-sm break-all text-tekst-svag">{email}</p>
            )}
            {(mitidVerificeret || populaerSaelger || foundingSeller) && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {mitidVerificeret && <MitIDMaerke />}
                {populaerSaelger && <PopulaerSaelgerMaerke />}
                {foundingSeller && <FoundingSellerMaerke />}
              </div>
            )}
            {erEgenProfil && mitidManglerEjer && (
              <div className="mt-1.5">
                {/* Almindeligt link: route handleren sender videre til MitID. */}
                <a
                  href={mitIdStartHref(`/profil/${brugerId}`)}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-advarsel-kant bg-advarsel-bg px-3 py-1.5 text-left text-[13px] font-semibold text-advarsel-tekst hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
                >
                  <Ikon navn="personTjek" className="h-4 w-4 shrink-0" strøg={2} />
                  {MITID.profilEjer}
                </a>
              </div>
            )}
          </div>

          {(erEgenProfil || handling) && (
            <div className="col-span-2 row-start-3 flex flex-wrap gap-2 sm:col-span-1 sm:col-start-3 sm:row-span-2 sm:row-start-1 max-sm:[&_.btn]:w-full max-sm:[&>*]:w-full sm:self-start">
              {erEgenProfil && (
                <Link
                  href={`/profil/${brugerId}?fane=indstillinger`}
                  className="btn btn-sekundaer"
                >
                  Rediger profil
                </Link>
              )}
              {handling}
            </div>
          )}

          <div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:self-start">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-tekst-svag">
              <span className="flex items-center gap-1.5">
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  aria-hidden="true"
                >
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <path strokeLinecap="round" d="M16 2v4M8 2v4M3 10h18" />
                </svg>
                Medlem siden {medlemSiden}
              </span>

              {antalRatings === 0 ? (
                <span className="text-tekst-svag">Ingen bedømmelser endnu</span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 fill-groen text-groen" aria-hidden="true">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                  {gennemsnitRating.toFixed(1).replace(".", ",")} · {antalRatings}{" "}
                  bedømmelse{antalRatings === 1 ? "" : "r"}
                </span>
              )}

              {typeof antalFoelgere === "number" && (
                <span className="flex items-center gap-1.5">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2M16 3.13a4 4 0 0 1 0 7.75M21 21v-2a4 4 0 0 0 -3 -3.85"
                    />
                  </svg>
                  {antalFoelgere === 1 ? "1 følger" : `${antalFoelgere.toLocaleString("da-DK")} følgere`}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Statistik-række */}
        {/* Budaktivitet vises kun paa egen profil (bydernes privatliv). */}
        <div className={`mt-5 grid gap-3 ${erEgenProfil ? "grid-cols-3" : "grid-cols-2"}`}>
          {[
            { tal: stats.auktionerOprettet, label: "Auktioner oprettet" },
            ...(erEgenProfil ? [{ tal: stats.budAfgivet, label: "Bud afgivet" }] : []),
            { tal: stats.gennemforteHandler, label: "Gennemførte salg" },
          ].map(({ tal, label }) => (
            <div
              key={label}
              className="min-w-0 rounded-xl bg-groen-lys px-2 py-3 text-center sm:px-3"
            >
              <p className="text-[22px] leading-tight font-bold text-tekst tabular-nums">{tal}</p>
              <p className="mt-0.5 text-xs leading-snug text-tekst-svag">{label}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
