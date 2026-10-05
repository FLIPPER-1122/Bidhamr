"use client";

import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { rapporter } from "@/app/actions/tryghed";
import { RAPPORT_BESKRIVELSE_MAKS, RAPPORT_KATEGORIER } from "@/lib/tryghed";

// "Rapportér" ved en chatbesked eller på en profil. Rapporten lander i admin
// under Rapporter -> Chat og profiler (bruger_rapporter).
export default function RapporterDialog({
  beskedId,
  brugerId,
  titel,
  triggerLabel,
  triggerClassName,
  triggerIcon,
}: {
  beskedId?: string;
  brugerId?: string;
  titel: string;
  triggerLabel: string;
  triggerClassName?: string;
  triggerIcon?: ReactNode;
}) {
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const [kategori, setKategori] = useState("");
  const [beskrivelse, setBeskrivelse] = useState("");
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [sendt, setSendt] = useState(false);

  useEffect(() => {
    if (!aaben) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sender) setAaben(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aaben, sender]);

  function luk() {
    if (sender) return;
    setAaben(false);
    setTimeout(() => {
      setKategori("");
      setBeskrivelse("");
      setFejl(null);
      setSendt(false);
    }, 200);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (sender) return;
    setFejl(null);
    if (!kategori) {
      setFejl("Vælg, hvad det drejer sig om.");
      return;
    }
    if (kategori === "andet" && !beskrivelse.trim()) {
      setFejl("Beskriv kort, hvad der er galt.");
      return;
    }
    setSender(true);
    const res = await rapporter({ beskedId, brugerId, kategori, beskrivelse });
    setSender(false);
    if ("fejl" in res) {
      setFejl(res.fejl);
      return;
    }
    setSendt(true);
  }

  return (
    <>
      <button type="button" onClick={() => setAaben(true)} className={triggerClassName}>
        {triggerIcon}
        {triggerLabel}
      </button>

      {aaben && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          onClick={luk}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-titel`}
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-[14px] sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            {sendt ? (
              <div className="text-center">
                <h2 id={`${id}-titel`} className="font-serif text-xl font-semibold text-tekst">
                  Tak for din rapport
                </h2>
                <p className="mt-2 text-sm text-tekst-daempet">
                  En medarbejder kigger på det hurtigst muligt. Den, du har rapporteret, får ikke at vide,
                  at det var dig.
                </p>
                <button type="button" onClick={luk} className="btn btn-primaer mt-5">
                  Luk
                </button>
              </div>
            ) : (
              <>
                <h2 id={`${id}-titel`} className="font-serif text-xl font-semibold text-tekst">
                  {titel}
                </h2>
                <p className="mt-1 text-sm text-tekst-daempet">
                  Fortæl os, hvad der er galt, så kigger en medarbejder på det.
                </p>
                <form onSubmit={send} className="mt-4 space-y-4">
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium text-tekst">Hvad drejer det sig om?</legend>
                    {RAPPORT_KATEGORIER.map((k) => (
                      <label
                        key={k.vaerdi}
                        className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm ${
                          kategori === k.vaerdi
                            ? "border-groen bg-groen-lys text-tekst"
                            : "border-kant-staerk text-tekst hover:bg-groen-lys/50"
                        }`}
                      >
                        <input
                          type="radio"
                          name={`${id}-kategori`}
                          value={k.vaerdi}
                          checked={kategori === k.vaerdi}
                          onChange={(e) => setKategori(e.target.value)}
                          className="accent-groen"
                        />
                        {k.label}
                      </label>
                    ))}
                  </fieldset>
                  <div>
                    <label htmlFor={`${id}-beskrivelse`} className="block text-sm font-medium text-tekst">
                      Beskrivelse{" "}
                      <span className="font-normal text-tekst-svag">
                        {kategori === "andet" ? "(påkrævet)" : "(valgfri)"}
                      </span>
                    </label>
                    <textarea
                      id={`${id}-beskrivelse`}
                      rows={3}
                      maxLength={RAPPORT_BESKRIVELSE_MAKS}
                      value={beskrivelse}
                      onChange={(e) => setBeskrivelse(e.target.value)}
                      className="min-h-11 mt-1.5 w-full rounded-xl border border-kant-staerk px-4 py-2.5 text-base text-tekst sm:text-sm bg-white placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
                    />
                  </div>
                  {fejl && (
                    <p role="alert" className="text-sm text-fejl-tekst">
                      {fejl}
                    </p>
                  )}
                  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <button type="button" onClick={luk} disabled={sender} className="btn btn-sekundaer">
                      Annullér
                    </button>
                    <button type="submit" disabled={sender} className="btn btn-primaer">
                      {sender ? "Sender…" : "Send rapport"}
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
