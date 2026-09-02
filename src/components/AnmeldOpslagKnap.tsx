"use client";

import { useEffect, useState, type FormEvent } from "react";
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

  useEffect(() => {
    if (!aaben) return;
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
        className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 hover:text-brand"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 21V5.25A2.25 2.25 0 015.25 3h6l.75 1.5h6.75a1.5 1.5 0 011.5 1.5v7.5a1.5 1.5 0 01-1.5 1.5H12l-.75-1.5H3" />
        </svg>
        Anmeld opslag
      </button>

      {aaben && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !sender && luk()}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {sendt ? (
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                  <svg viewBox="0 0 24 24" className="h-6 w-6 text-green-600" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 className="text-lg font-bold text-neutral-900">Tak for din anmeldelse</h2>
                <p className="mt-1.5 text-sm text-neutral-500">
                  Vi kigger på opslaget hurtigst muligt.
                </p>
                <button
                  type="button"
                  onClick={luk}
                  className="mt-5 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38]"
                >
                  Luk
                </button>
              </div>
            ) : (
              <>
                <h2 className="text-lg font-bold text-neutral-900">Anmeld opslag</h2>
                <p className="mt-1 text-sm text-neutral-500">
                  Fortæl os hvad der er galt, så kigger en medarbejder på det.
                </p>

                <form onSubmit={handleSubmit} className="mt-4 space-y-4">
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium text-neutral-700">
                      Hvad drejer det sig om?
                    </legend>
                    {ANMELDELSE_KATEGORIER.map((k) => (
                      <label
                        key={k.vaerdi}
                        className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                          kategori === k.vaerdi
                            ? "border-brand bg-[#FDECEE] text-neutral-900"
                            : "border-neutral-200 text-neutral-700 hover:bg-neutral-50"
                        }`}
                      >
                        <input
                          type="radio"
                          name="kategori"
                          value={k.vaerdi}
                          checked={kategori === k.vaerdi}
                          onChange={(e) => setKategori(e.target.value)}
                          className="accent-brand"
                        />
                        {k.label}
                      </label>
                    ))}
                  </fieldset>

                  <div>
                    <label htmlFor="beskrivelse" className="block text-sm font-medium text-neutral-700">
                      Beskrivelse{" "}
                      <span className="font-normal text-neutral-400">
                        {kategori === "andet" ? "(påkrævet)" : "(valgfri)"}
                      </span>
                    </label>
                    <textarea
                      id="beskrivelse"
                      rows={3}
                      value={beskrivelse}
                      onChange={(e) => setBeskrivelse(e.target.value)}
                      placeholder="Uddyb gerne, så vi hurtigere kan vurdere sagen..."
                      className="mt-1.5 w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                    />
                  </div>

                  {fejl && <p className="text-sm text-red-600">{fejl}</p>}

                  <div className="flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={luk}
                      disabled={sender}
                      className="rounded-lg bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-200 disabled:opacity-50"
                    >
                      Annullér
                    </button>
                    <button
                      type="submit"
                      disabled={sender}
                      className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38] disabled:opacity-50"
                    >
                      {sender ? "Sender…" : "Send anmeldelse"}
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
