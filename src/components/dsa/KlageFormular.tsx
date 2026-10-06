"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { klagOverAfgoerelse, klagSomAnmelder } from "@/app/actions/dsa";
import { DSA_BEGRUNDELSE_MAKS, DSA_BEGRUNDELSE_MIN } from "@/lib/dsa/regler";

// Klage over en afgørelse (DSA art. 20). Én klage pr. afgørelse.
export default function KlageFormular({
  type,
  id,
  token,
}: {
  type: "afgoerelse" | "anmeldelse";
  id: string;
  token?: string | null;
}) {
  const uid = useId();
  const router = useRouter();
  const [tekst, setTekst] = useState("");
  const [fejl, setFejl] = useState<string | null>(null);
  const [sendt, setSendt] = useState(false);
  const [sender, startSend] = useTransition();

  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFejl(null);
    if (tekst.trim().length < DSA_BEGRUNDELSE_MIN) {
      setFejl("Forklar lidt mere, hvorfor du er uenig.");
      return;
    }
    const fd = new FormData(e.currentTarget);
    startSend(async () => {
      const r = type === "afgoerelse" ? await klagOverAfgoerelse(fd) : await klagSomAnmelder(fd);
      if ("fejl" in r) {
        setFejl(r.fejl);
        return;
      }
      setSendt(true);
      router.refresh();
    });
  }

  if (sendt) {
    return (
      <p role="status" className="rounded-xl bg-succes-bg p-4 text-sm text-succes-tekst">
        Tak. Vi har modtaget din klage. En anden medarbejder end den, der traf afgørelsen, ser på den, og du får svar
        på mail.
      </p>
    );
  }

  return (
    <form onSubmit={indsend} className="space-y-3" noValidate>
      <input type="hidden" name={type === "afgoerelse" ? "afgoerelseId" : "anmeldelseId"} value={id} />
      {token && <input type="hidden" name="t" value={token} />}
      <div>
        <label htmlFor={`${uid}-klage`} className="block text-sm font-medium text-tekst">
          Hvorfor er du uenig?
        </label>
        <textarea
          id={`${uid}-klage`}
          name="begrundelse"
          rows={5}
          required
          minLength={DSA_BEGRUNDELSE_MIN}
          maxLength={DSA_BEGRUNDELSE_MAKS}
          value={tekst}
          onChange={(e) => setTekst(e.target.value)}
          placeholder="Forklar, hvorfor du mener, at afgørelsen er forkert. Har du nye oplysninger, så skriv dem her."
          className="mt-1.5 min-h-[120px] w-full rounded-xl border border-kant-staerk bg-white px-4 py-2.5 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
        />
        <p className="mt-1 text-right text-[13px] text-tekst-svag">
          {tekst.length.toLocaleString("da-DK")} / {DSA_BEGRUNDELSE_MAKS.toLocaleString("da-DK")}
        </p>
      </div>
      {fejl && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}
      <button type="submit" disabled={sender} aria-busy={sender || undefined} className="btn btn-primaer">
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        Send klage
      </button>
      <p className="text-[13px] text-tekst-svag">Der er ét klagetrin. Svaret på klagen er BidHamrs endelige afgørelse.</p>
    </form>
  );
}
