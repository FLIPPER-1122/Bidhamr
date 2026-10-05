"use client";

import Image from "next/image";
import Link from "next/link";
import { kanOptimeres } from "@/lib/billedUrl";
import { useSearchParams, useRouter } from "next/navigation";
import AuctionCard, { type DummyAuction } from "@/components/AuctionCard";
import SettingsForm from "@/components/profile/SettingsForm";

export type BudStatus = "vinder" | "overbud" | "aktiv";

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
}

export interface Rating {
  id: string;
  fra_bruger_id: string;
  fra_bruger_navn: string;
  stjerner: number;
  kommentar: string | null;
  oprettet: string;
}

const BUD_STYLE: Record<BudStatus, string> = {
  vinder: "bg-succes-bg text-succes-tekst",
  overbud: "bg-fejl-bg text-fejl-tekst",
  aktiv: "bg-kant text-tekst-daempet",
};

const BUD_LABEL: Record<BudStatus, string> = {
  vinder: "Vinder",
  overbud: "Overbud",
  aktiv: "Aktiv",
};

type Fane = "auktioner" | "bud" | "bedommelser" | "indstillinger";

function auktionStatusBadge(slutterKl: string, harBud: boolean, status?: string) {
  if (status === "annulleret") return { label: "Annulleret", cls: "bg-kant text-tekst-daempet" };
  const erSlut = new Date(slutterKl) <= new Date();
  if (!erSlut) return { label: "Aktiv", cls: "bg-succes-bg text-succes-tekst" };
  if (harBud) return { label: "Venter på betaling", cls: "bg-advarsel-bg text-advarsel-tekst" };
  return { label: "Afsluttet", cls: "bg-kant text-tekst-daempet" };
}

export default function ProfileTabs({
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
  const searchParams = useSearchParams();
  const router = useRouter();
  const raw = searchParams.get("fane");
  const fane: Fane =
    raw === "indstillinger" || raw === "bud" || raw === "bedommelser"
      ? (raw as Fane)
      : "auktioner";

  function setFane(f: Fane) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("fane", f);
    router.push(`?${params.toString()}`);
  }

  const faner: [Fane, string][] = [
    ["auktioner", "Mine auktioner"],
    ["bud", "Mine bud"],
    ["bedommelser", "Bedømmelser"],
    ["indstillinger", "Indstillinger"],
  ];

  return (
    <div className="mt-6">
      {/* Tab-bar */}
      <div className="-mx-4 flex gap-1 overflow-x-auto border-b border-kant px-4 sm:mx-0 sm:px-0">
        {faner.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFane(key)}
            aria-pressed={fane === key}
            className={`flex min-h-11 shrink-0 items-center border-b-2 px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen ${
              fane === key
                ? "border-groen text-groen"
                : "border-transparent text-tekst-daempet hover:text-tekst"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {/* Mine auktioner */}
        {fane === "auktioner" && (
          egneAuktioner.length === 0 ? (
            <div className="rounded-[14px] border border-kant bg-white px-6 py-10 text-center">
              <p className="text-sm text-tekst-svag">
                Du har ikke oprettet nogen auktioner endnu.
              </p>
              <Link
                href="/opret-auktion"
                className="btn btn-primaer mt-4"
              >
                Opret din første auktion
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
              {egneAuktioner.map((auktion) => {
                const badge = auktionStatusBadge(auktion.slutterKl, auktion.antalBud > 0, auktion.status);
                return (
                  <div key={auktion.id} className="relative">
                    <span
                      className={`absolute top-2 left-2 z-10 rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.cls}`}
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
            <div className="rounded-[14px] border border-kant bg-white px-6 py-10 text-center">
              <p className="text-sm text-tekst-svag">
                Du har ikke afgivet nogen bud endnu.
              </p>
              <Link
                href="/auktioner"
                className="btn btn-primaer mt-4"
              >
                Se alle auktioner
              </Link>
            </div>
          ) : (
            <ul className="divide-y divide-kant rounded-[14px] border border-kant bg-white">
              {mineBud.map((bud) => (
                <li key={bud.auktionId} className="flex items-center gap-3 px-4 py-3.5 sm:gap-4">
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
                    <Link
                      href={`/auktion/${bud.auktionId}`}
                      className="block truncate rounded-md text-sm font-medium text-tekst hover:text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
                    >
                      {bud.titel}
                    </Link>
                    <p className="mt-0.5 text-xs text-tekst-svag">
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

        {/* Bedømmelser */}
        {fane === "bedommelser" && (
          ratings.length === 0 ? (
            <div className="rounded-[14px] border border-kant bg-white px-6 py-10 text-center">
              <p className="text-sm text-tekst-svag">
                Du har ingen bedømmelser endnu.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {ratings.map((rating) => (
                <li
                  key={rating.id}
                  className="rounded-[14px] border border-kant bg-white p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-groen-lys text-xs font-semibold text-tekst-daempet">
                        {rating.fra_bruger_navn[0]}
                      </div>
                      <Link
                        href={`/profil/${rating.fra_bruger_id}`}
                        className="text-sm font-medium text-tekst hover:text-groen hover:underline"
                      >
                        {rating.fra_bruger_navn}
                      </Link>
                    </div>
                    <span className="shrink-0 text-xs text-tekst-svag">
                      {new Date(rating.oprettet).toLocaleDateString("da-DK", {
                        dateStyle: "medium",
                      })}
                    </span>
                  </div>

                  <div className="mt-2 flex gap-0.5" role="img" aria-label={`${rating.stjerner} af 5 stjerner`}>
                    {[1, 2, 3, 4, 5].map((i) => (
                      <svg
                        key={i}
                        viewBox="0 0 24 24"
                        className={`h-4 w-4 ${
                          i <= rating.stjerner
                            ? "fill-groen text-groen"
                            : "fill-kant-staerk text-kant-staerk"
                        }`}
                      >
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                      </svg>
                    ))}
                  </div>

                  {rating.kommentar && (
                    <p className="mt-2 text-sm text-tekst-daempet">
                      {rating.kommentar}
                    </p>
                  )}
                </li>
              ))}
            </ul>
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
