"use client";

// Staff skjuler eller viser et spørgsmål (skjulSpoergsmaal - assertRole i
// src/app/actions/spoergsmaal.ts). Bruges på auktionssiden uden ADMIN_VAERT og
// på Admin → Auktioner → Spørgsmål (/admin/auktioner/<id>/spoergsmaal).
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { skjulSpoergsmaal } from "@/app/actions/spoergsmaal";
import { REGEL_VALG } from "@/lib/dsa/regler";
import { NETVAERKSFEJL } from "@/lib/auktionRegler";
import { useHydreret } from "@/lib/useHydreret";

const felt =
  "w-full rounded-xl border border-kant-staerk bg-white px-4 py-3 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25";
const sekundaer =
  "inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-groen bg-white px-4 text-sm font-semibold text-groen transition-colors hover:bg-groen-lys focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen disabled:cursor-not-allowed disabled:border-kant-staerk disabled:text-tekst-svag";

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
    />
  );
}

export default function SkjulSpoergsmaal({
  auktionId,
  spoergsmaalId,
  skjult,
}: {
  auktionId: string;
  spoergsmaalId: string;
  skjult: boolean;
}) {
  const router = useRouter();
  const hydreret = useHydreret();
  const [aaben, setAaben] = useState(false);
  const [grund, setGrund] = useState("");
  const [regel, setRegel] = useState("chikane");
  const [fejl, setFejl] = useState<string | null>(null);
  const [skjuler, start] = useTransition();

  function skjul(e?: FormEvent) {
    e?.preventDefault();
    setFejl(null);
    const nyTilstand = !skjult;
    if (nyTilstand && !grund.trim()) {
      setFejl("Skriv en begrundelse.");
      return;
    }
    start(async () => {
      let r: Awaited<ReturnType<typeof skjulSpoergsmaal>>;
      try {
        r = await skjulSpoergsmaal(auktionId, spoergsmaalId, nyTilstand, grund.trim(), regel);
      } catch (err) {
        console.error("skjulSpoergsmaal fejlede:", err);
        setFejl(NETVAERKSFEJL);
        return;
      }
      if ("fejl" in r) {
        setFejl(r.fejl);
        return;
      }
      setAaben(false);
      setGrund("");
      router.refresh();
    });
  }

  return (
    <div className="mt-3 border-t border-kant pt-3">
      {skjult ? (
        <button type="button" onClick={() => skjul()} disabled={skjuler} className={sekundaer}>
          {skjuler && <Spinner />}
          Vis spørgsmålet igen
        </button>
      ) : aaben ? (
        <form onSubmit={skjul} method="post" noValidate>
          <label htmlFor={`regel-${spoergsmaalId}`} className="mb-1.5 block text-sm font-medium text-tekst">
            Hvilken regel bryder det?
          </label>
          <select
            id={`regel-${spoergsmaalId}`}
            value={regel}
            onChange={(e) => setRegel(e.target.value)}
            className={`${felt} mb-3 h-11 py-0`}
          >
            {REGEL_VALG.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <label htmlFor={`grund-${spoergsmaalId}`} className="mb-1.5 block text-sm font-medium text-tekst">
            Begrundelse til den, der skrev det (vises for brugeren, som kan klage)
          </label>
          <input
            id={`grund-${spoergsmaalId}`}
            value={grund}
            onChange={(e) => setGrund(e.target.value)}
            maxLength={500}
            className={`${felt} h-11 py-0`}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="submit" disabled={skjuler || !hydreret} className={sekundaer}>
              {skjuler && <Spinner />}
              Skjul
            </button>
            <button
              type="button"
              onClick={() => setAaben(false)}
              className="inline-flex h-11 items-center px-3 text-sm font-medium text-groen hover:underline"
            >
              Annullér
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAaben(true)}
          className="inline-flex min-h-11 items-center text-sm font-medium text-groen hover:underline"
        >
          Skjul spørgsmål (staff)
        </button>
      )}
      {fejl && (
        <p role="alert" className="mt-1.5 text-[13px] font-medium text-fejl-tekst">
          {fejl}
        </p>
      )}
    </div>
  );
}
