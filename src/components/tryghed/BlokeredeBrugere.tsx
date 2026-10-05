"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fjernBlokering } from "@/app/actions/tryghed";

export type Blokering = {
  id: string;
  // null = en anonym byder, der er spærret fra en af dine auktioner.
  brugerId: string | null;
  navn: string | null;
  auktionId: string | null;
  auktionTitel: string | null;
  oprettetKl: string;
};

// Listen under Min konto med "Fjern blokering".
export default function BlokeredeBrugere({ blokeringer }: { blokeringer: Blokering[] }) {
  const router = useRouter();
  const [fjernet, setFjernet] = useState<Set<string>>(new Set());
  const [fejl, setFejl] = useState<string | null>(null);
  const [arbejder, setArbejder] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const synlige = blokeringer.filter((b) => !fjernet.has(b.id));

  function fjern(id: string) {
    setFejl(null);
    setArbejder(id);
    startTransition(async () => {
      const res = await fjernBlokering(id);
      setArbejder(null);
      if ("fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      setFjernet((s) => new Set(s).add(id));
      router.refresh();
    });
  }

  if (synlige.length === 0) {
    return <p className="text-sm text-tekst-daempet">Du har ikke blokeret nogen.</p>;
  }

  return (
    <>
      <ul className="divide-y divide-kant">
        {synlige.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
            <div className="min-w-0">
              {b.brugerId ? (
                <Link
                  href={`/profil/${b.brugerId}`}
                  className="block truncate text-sm font-medium text-tekst hover:text-groen hover:underline"
                >
                  {b.navn ?? "Bruger"}
                </Link>
              ) : (
                <p className="text-sm font-medium text-tekst">
                  En byder på{" "}
                  {b.auktionId ? (
                    <Link href={`/auktion/${b.auktionId}`} className="text-groen hover:underline">
                      {b.auktionTitel ?? "din auktion"}
                    </Link>
                  ) : (
                    "en af dine auktioner"
                  )}
                </p>
              )}
              <p className="text-xs text-tekst-svag">
                Blokeret{" "}
                {new Date(b.oprettetKl).toLocaleDateString("da-DK", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                  timeZone: "Europe/Copenhagen",
                })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => fjern(b.id)}
              disabled={arbejder === b.id}
              className="btn btn-sekundaer btn-lille"
            >
              {arbejder === b.id ? "Fjerner…" : "Fjern blokering"}
            </button>
          </li>
        ))}
      </ul>
      {fejl && (
        <p role="alert" className="mt-3 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}
    </>
  );
}
