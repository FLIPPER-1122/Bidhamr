"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { ANMELDELSE_KATEGORIER } from "@/lib/anmeldelseKategorier";

export default function AnmeldOpslagKnap({
  auktionId,
  brugerId,
}: {
  auktionId: string;
  brugerId: string | null;
}) {
  const [aaben, setAaben] = useState(false);
  const [kategori, setKategori] = useState<string>("");
  const [beskrivelse, setBeskrivelse] = useState("");
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [sendt, setSendt] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!aaben) return;
    // Fokus ind i dialogen, så tastatur- og skærmlæserbrugere lander der.
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAaben(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aaben]);

  function luk() {
    setAaben(false);
    // Nulstil, så en ny anmeldelse starter forfra næste gang.
    setTimeout(() => {
      setKategori("");
      setBeskrivelse("");
      setFejl(null);
      setSendt(false);
    }, 200);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFejl(null);

    if (!brugerId) {
      setFejl("Du skal være logget ind for at anmelde et opslag.");
      return;
    }
    if (!kategori) {
      setFejl("Vælg en kategori.");
      return;
    }
    // "Andet" giver ingen mening uden en forklaring.
    if (kategori === "andet" && !beskrivelse.trim()) {
      setFejl("Beskriv venligst hvad du vil anmelde.");
      return;
    }

    setSender(true);
    const supabase = createClient();
    const { error } = await supabase.from("reports").insert({
      auction_id: auktionId,
      reporter_id: brugerId,
      category: kategori,
      description: beskrivelse.trim() || null,
    });
    setSender(false);

    if (error) {
      setFejl(error.message);
      return;
    }
    setSendt(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setAaben(true)}
        aria-haspopup="dialog"
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md text-[13px] font-medium text-tekst-svag hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 21V5.25A2.25 2.25 0 015.25 3h6l.75 1.5h6.75a1.5 1.5 0 011.5 1.5v7.5a1.5 1.5 0 01-1.5 1.5H12l-.75-1.5H3" />
        </svg>
        Anmeld opslag
      </button>

      {aaben && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          onClick={() => !sender && luk()}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="anmeld-titel"
            tabIndex={-1}
            className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-[18px] bg-white p-5 shadow-stor outline-none sm:rounded-[14px] sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            {sendt ? (
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-succes-bg">
                  <svg viewBox="0 0 24 24" className="h-6 w-6 text-succes-tekst" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 id="anmeld-titel" className="text-[20px] leading-tight">Tak for din anmeldelse</h2>
                <p className="mt-1.5 text-sm text-tekst-svag">
                  Vi kigger på opslaget hurtigst muligt.
                </p>
                <button
                  type="button"
                  onClick={luk}
                  className="btn btn-primaer mt-5"
                >
                  Luk
                </button>
              </div>
            ) : (
              <>
                <h2 id="anmeld-titel" className="text-[20px] leading-tight">Anmeld opslag</h2>
                <p className="mt-1 text-sm text-tekst-svag">
                  Fortæl os hvad der er galt, så kigger en medarbejder på det.
                </p>

                <form onSubmit={handleSubmit} className="mt-4 space-y-4">
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium text-tekst">
                      Hvad drejer det sig om?
                    </legend>
                    {ANMELDELSE_KATEGORIER.map((k) => (
                      <label
                        key={k.vaerdi}
                        className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm transition-colors ${
                          kategori === k.vaerdi
                            ? "border-groen bg-groen-lys text-tekst"
                            : "border-kant text-tekst-daempet hover:bg-groen-lys"
                        }`}
                      >
                        <input
                          type="radio"
                          name="kategori"
                          value={k.vaerdi}
                          checked={kategori === k.vaerdi}
                          onChange={(e) => setKategori(e.target.value)}
                          className="h-5 w-5 shrink-0 accent-groen"
                        />
                        {k.label}
                      </label>
                    ))}
                  </fieldset>

                  <div>
                    <label htmlFor="beskrivelse" className="block text-sm font-medium text-tekst">
                      Beskrivelse{" "}
                      <span className="font-normal text-tekst-svag">
                        {kategori === "andet" ? "(påkrævet)" : "(valgfri)"}
                      </span>
                    </label>
                    <textarea
                      id="beskrivelse"
                      rows={3}
                      value={beskrivelse}
                      onChange={(e) => setBeskrivelse(e.target.value)}
                      placeholder="Uddyb gerne, så vi hurtigere kan vurdere sagen..."
                      className="mt-1.5 min-h-[96px] w-full rounded-xl border border-kant-staerk px-4 py-2.5 text-[15px] bg-white text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
                    />
                  </div>

                  {fejl && (
                    <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
                      {fejl}
                    </p>
                  )}

                  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
                    <button
                      type="button"
                      onClick={luk}
                      disabled={sender}
                      className="btn btn-sekundaer"
                    >
                      Annullér
                    </button>
                    <button
                      type="submit"
                      disabled={sender}
                      aria-busy={sender || undefined}
                      className="btn btn-primaer"
                    >
                      {sender && <span className="btn-spinner" aria-hidden="true" />}
                      Send anmeldelse
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
