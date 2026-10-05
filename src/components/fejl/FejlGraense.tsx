"use client";

import Link from "next/link";
import { useRapporterFejl } from "@/components/drift/useRapporterFejl";

// Fælles indhold til error.tsx (DESIGN.md afsnit 9: overskrift, kort
// forklaring, "Prøv igen" som sekundær knap og "Til forsiden" som tekstlink).
// Fejlen logges til /admin/drift (kun sti, besked og digest).
export default function FejlGraense({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useRapporterFejl(error);

  return (
    <main className="flex flex-1 items-center justify-center bg-white px-4 py-16 sm:py-24">
      <div role="alert" className="w-full max-w-md text-center">
        <h2 className="font-serif text-2xl font-semibold text-tekst">Noget gik galt</h2>
        <p className="mt-2 text-[15px] text-tekst-daempet">
          Siden kunne ikke vises lige nu. Prøv igen om lidt. Sker det igen, må du gerne skrive til os, så
          kigger vi på det.
        </p>
        {error.digest && <p className="mt-2 text-xs text-tekst-svag">Fejlkode: {error.digest}</p>}
        <div className="mt-6 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <button type="button" onClick={() => retry()} className="btn btn-sekundaer">
            Prøv igen
          </button>
          <Link href="/" className="text-sm font-medium text-groen hover:underline">
            Til forsiden
          </Link>
          <Link href="/kontakt?emne=fejl" className="text-sm font-medium text-groen hover:underline">
            Rapportér fejlen
          </Link>
        </div>
      </div>
    </main>
  );
}
