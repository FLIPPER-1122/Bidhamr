"use client";

import Link from "next/link";
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
  vinder: "bg-green-100 text-green-700",
  overbud: "bg-red-100 text-red-700",
  aktiv: "bg-neutral-100 text-neutral-600",
};

const BUD_LABEL: Record<BudStatus, string> = {
  vinder: "Vinder",
  overbud: "Overbud",
  aktiv: "Aktiv",
};

type Fane = "auktioner" | "bud" | "bedommelser" | "indstillinger";

function auktionStatusBadge(slutterKl: string, harBud: boolean) {
  const erSlut = new Date(slutterKl) <= new Date();
  if (!erSlut) return { label: "Aktiv", cls: "bg-green-100 text-green-700" };
  if (harBud) return { label: "Venter på betaling", cls: "bg-orange-100 text-orange-700" };
  return { label: "Afsluttet", cls: "bg-neutral-100 text-neutral-500" };
}

export default function ProfileTabs({
  egneAuktioner,
  mineBud,
  ratings,
  brugerId,
  navn,
  telefon,
  email,
  avatarUrl,
}: {
  egneAuktioner: EgenAuktion[];
  mineBud: MitBud[];
  ratings: Rating[];
  brugerId: string;
  navn: string;
  telefon: string | null;
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
      <div className="flex gap-1 overflow-x-auto border-b border-neutral-200">
        {faner.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFane(key)}
            className={`shrink-0 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
              fane === key
                ? "border-brand text-brand"
                : "border-transparent text-neutral-500 hover:text-neutral-800"
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
            <div className="rounded-xl border border-dashed border-neutral-200 py-16 text-center">
              <p className="text-sm text-neutral-500">
                Du har ikke oprettet nogen auktioner endnu.
              </p>
              <Link
                href="/opret-auktion"
                className="mt-4 inline-block rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38]"
              >
                Opret din første auktion
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
              {egneAuktioner.map((auktion) => {
                const badge = auktionStatusBadge(auktion.slutterKl, auktion.antalBud > 0);
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
            <div className="rounded-xl border border-dashed border-neutral-200 py-16 text-center">
              <p className="text-sm text-neutral-500">
                Du har ikke afgivet nogen bud endnu.
              </p>
              <Link
                href="/auktioner"
                className="mt-4 inline-block rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38]"
              >
                Se alle auktioner
              </Link>
            </div>
          ) : (
            <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200">
              {mineBud.map((bud) => (
                <li key={bud.auktionId} className="flex items-center gap-4 px-4 py-3.5">
                  <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-neutral-100">
                    {bud.billede && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={bud.billede}
                        alt={bud.titel}
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/auktion/${bud.auktionId}`}
                      className="block truncate text-sm font-medium text-neutral-900 hover:text-brand"
                    >
                      {bud.titel}
                    </Link>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      Dit bud:{" "}
                      <span className="font-semibold text-neutral-800">
                        {bud.egetBud.toLocaleString("da-DK")} kr
                      </span>
                      {bud.højesteBud !== bud.egetBud && (
                        <>
                          {" "}· Højeste:{" "}
                          <span className="font-semibold text-neutral-800">
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
            <div className="rounded-xl border border-dashed border-neutral-200 py-16 text-center">
              <p className="text-sm text-neutral-500">
                Du har ingen bedømmelser endnu.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {ratings.map((rating) => (
                <li
                  key={rating.id}
                  className="rounded-xl border border-neutral-200 bg-white p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-xs font-semibold text-neutral-600">
                        {rating.fra_bruger_navn[0]}
                      </div>
                      <Link
                        href={`/profil/${rating.fra_bruger_id}`}
                        className="text-sm font-medium text-neutral-900 hover:text-brand hover:underline"
                      >
                        {rating.fra_bruger_navn}
                      </Link>
                    </div>
                    <span className="shrink-0 text-xs text-neutral-400">
                      {new Date(rating.oprettet).toLocaleDateString("da-DK", {
                        dateStyle: "medium",
                      })}
                    </span>
                  </div>

                  <div className="mt-2 flex gap-0.5">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <svg
                        key={i}
                        viewBox="0 0 24 24"
                        className={`h-4 w-4 ${
                          i <= rating.stjerner
                            ? "fill-brand text-brand"
                            : "fill-neutral-200 text-neutral-200"
                        }`}
                      >
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                      </svg>
                    ))}
                  </div>

                  {rating.kommentar && (
                    <p className="mt-2 text-sm text-neutral-600">
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
            email={email}
            avatarUrl={avatarUrl}
          />
        )}
      </div>
    </div>
  );
}
