import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { kanOptimeres } from "@/lib/billedUrl";

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
}: ProfileHeaderProps) {
  return (
    <div className="overflow-hidden rounded-[14px] border border-kant bg-white">
      <div className="px-5 pb-6 pt-6 sm:px-8">
        {/* Avatar + navn */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-full border border-kant bg-groen-lys sm:h-24 sm:w-24">
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
                className="h-full w-full p-5 text-groen-mork"
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

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h1 className="min-w-0 text-[26px] leading-tight break-words sm:text-[32px]">
                {navn}
              </h1>
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
            {email && (
              <p className="mt-0.5 text-sm break-all text-tekst-svag">{email}</p>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-tekst-svag">
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
