"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { accepterVilkaar } from "@/app/actions/vilkaar";
import { BETINGELSER_STI, VILKAAR_VERSION } from "@/lib/vilkaar";

// Lille, venlig bjælke på /konto til brugere, der ikke har accepteret den
// aktuelle version af brugerbetingelserne (oprettet før de fandtes, eller via
// appen uden fluebenet). Blokerer ikke noget.
export default function VilkaarBjaelke() {
  const router = useRouter();
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [faerdig, setFaerdig] = useState(false);

  async function accepter() {
    setSender(true);
    setFejl(null);
    const svar = await accepterVilkaar(VILKAAR_VERSION);
    setSender(false);
    if ("fejl" in svar) {
      setFejl(svar.fejl);
      return;
    }
    setFaerdig(true);
    router.refresh();
  }

  if (faerdig) {
    return (
      <p role="status" className="mt-6 rounded-xl border border-kant bg-groen-lys p-4 text-sm text-groen-mork">
        Tak – vi har gemt, at du har accepteret brugerbetingelserne.
      </p>
    );
  }

  return (
    <section
      aria-labelledby="vilkaar-bjaelke-titel"
      className="mt-6 flex flex-col gap-3 rounded-xl border border-kant bg-groen-lys p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="text-sm text-groen-mork">
        <p id="vilkaar-bjaelke-titel" className="font-semibold">
          Vi har lavet brugerbetingelser –{" "}
          <a
            href={BETINGELSER_STI}
            target="_blank"
            rel="noopener"
            className="underline underline-offset-2 hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
          >
            læs dem her
            <span className="sr-only"> (åbner i et nyt vindue)</span>
          </a>
        </p>
        {fejl && (
          <p role="alert" className="mt-1 text-fejl-tekst">
            {fejl}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={accepter}
        disabled={sender}
        aria-busy={sender || undefined}
        className="btn btn-sekundaer w-full shrink-0 sm:w-auto"
      >
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        Jeg har læst og accepterer
      </button>
    </section>
  );
}
