"use client";

import Link from "next/link";
import { useRapporterFejl } from "@/components/drift/useRapporterFejl";

// Fejlside efter DESIGN.md 9: overskrift, kort forklaring, "Prøv igen" og "Til forsiden".
// TODO indhold-agenten: endelig fejltekst.
export default function Fejl({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useRapporterFejl(error);
  return (
    <main className="flex flex-1 items-center justify-center bg-white px-4 py-16">
      <div className="max-w-md text-center">
        <h2 className="text-xl lg:text-[22px]">Forsiden kunne ikke vises</h2>
        <p className="mt-2 text-[15px] text-tekst-daempet">
          Vi kunne ikke hente auktionerne lige nu. Prøv igen om et øjeblik.
        </p>
        <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <button type="button" onClick={() => retry()} className="btn btn-sekundaer">
            Prøv igen
          </button>
          <Link href="/auktioner" className="btn btn-tekst min-h-11">
            Se alle auktioner
          </Link>
        </div>
      </div>
    </main>
  );
}
