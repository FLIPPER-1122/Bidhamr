"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import AuctionCard, { type DummyAuction } from "@/components/AuctionCard";
import SettingsForm from "@/components/profile/SettingsForm";

export type BudStatus = "vinder" | "overbud" | "aktiv";

export interface MitBud {
  auktionId: string;
  titel: string;
  billede: string | null;
  egetBud: number;
  status: BudStatus;
}

const STATUS_STYLE: Record<BudStatus, string> = {
  vinder: "bg-green-100 text-green-700",
  overbud: "bg-red-100 text-red-700",
  aktiv: "bg-neutral-200 text-neutral-600",
};

const STATUS_LABEL: Record<BudStatus, string> = {
  vinder: "Vinder",
  overbud: "Overbud",
  aktiv: "Aktiv",
};

type Fane = "auktioner" | "bud" | "indstillinger";

export default function ProfileTabs({
  egneAuktioner,
  mineBud,
  brugerId,
  navn,
  telefon,
  email,
  avatarUrl,
}: {
  egneAuktioner: DummyAuction[];
  mineBud: MitBud[];
  brugerId: string;
  navn: string;
  telefon: string | null;
  email: string;
  avatarUrl: string | null;
}) {
  const searchParams = useSearchParams();
  const initialFane = searchParams.get("fane");
  const [fane, setFane] = useState<Fane>(
    initialFane === "indstillinger" || initialFane === "bud"
      ? initialFane
      : "auktioner",
  );

  return (
    <div>
      <div className="flex gap-6 border-b border-neutral-200">
        {(
          [
            ["auktioner", "Mine auktioner"],
            ["bud", "Mine bud"],
            ["indstillinger", "Indstillinger"],
          ] as [Fane, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFane(key)}
            className={`border-b-2 px-1 py-3 text-sm font-medium ${
              fane === key
                ? "border-brand text-brand"
                : "border-transparent text-neutral-500 hover:text-neutral-700"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {fane === "auktioner" && (
          egneAuktioner.length === 0 ? (
            <p className="text-sm text-neutral-500">
              Du har ikke oprettet nogen auktioner endnu.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
              {egneAuktioner.map((auktion) => (
                <AuctionCard key={auktion.id} auktion={auktion} />
              ))}
            </div>
          )
        )}

        {fane === "bud" && (
          mineBud.length === 0 ? (
            <p className="text-sm text-neutral-500">
              Du har ikke afgivet nogen bud endnu.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {mineBud.map((bud) => (
                <li key={bud.auktionId} className="flex items-center gap-3 py-3">
                  <div className="h-14 w-14 shrink-0 overflow-hidden bg-neutral-100">
                    {bud.billede && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={bud.billede}
                        alt={bud.titel}
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>

                  <Link
                    href={`/auktion/${bud.auktionId}`}
                    className="flex-1 truncate text-sm font-medium text-neutral-900 hover:text-brand"
                  >
                    {bud.titel}
                  </Link>

                  <span className="text-sm font-semibold text-neutral-900">
                    {bud.egetBud.toLocaleString("da-DK")} kr
                  </span>

                  <span
                    className={`px-2 py-1 text-xs font-semibold ${STATUS_STYLE[bud.status]}`}
                  >
                    {STATUS_LABEL[bud.status]}
                  </span>
                </li>
              ))}
            </ul>
          )
        )}

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
