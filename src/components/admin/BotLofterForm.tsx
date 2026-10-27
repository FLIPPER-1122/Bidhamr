"use client";

import { useState, useTransition, type FormEvent } from "react";
import { gemBotIndstillinger } from "@/app/actions/adminBot";
import { FELT as FELT_FAELLES } from "@/components/konto/felter";
import { useHydreret } from "@/lib/useHydreret";

// Admin -> BidHamr-bot (kun chef): døgnlofterne. Serveren og databasen
// tjekker rollen og grænserne igen.

const FELT = `mt-1.5 ${FELT_FAELLES} font-normal`;
const ETIKET = "block text-sm font-medium text-tekst";
const HJAELP = "mt-1 block text-xs font-normal text-tekst-svag";

export default function BotLofterForm(p: {
  doegnloftUsd: number;
  anonAndel: number;
  brugerLoftUsd: number;
  doegnloftAnon: number;
}) {
  const [pending, start] = useTransition();
  const hydreret = useHydreret();
  const [besked, setBesked] = useState<{ fejl: boolean; tekst: string } | null>(null);
  const komma = (v: number) => String(Number(v)).replace(".", ",");

  function gem(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBesked(null);
    start(async () => {
      const res = await gemBotIndstillinger(fd);
      setBesked("fejl" in res ? { fejl: true, tekst: res.fejl } : { fejl: false, tekst: "Gemt." });
    });
  }

  return (
    <form onSubmit={gem} method="post" className="grid gap-3 border border-admin-kant bg-white p-4 sm:grid-cols-2">
      <label className={ETIKET}>
        Døgnloft i alt (USD)
        <input name="doegnloft_usd" defaultValue={komma(p.doegnloftUsd)} inputMode="decimal" required className={FELT} />
        <span className={HJAELP}>Når prisen for alle svar det seneste døgn når loftet, holder botten pause for alle.</span>
      </label>
      <label className={ETIKET}>
        Andel til besøgende uden login (%)
        <input name="anon_procent" defaultValue={komma(Math.round(p.anonAndel * 1000) / 10)} inputMode="decimal" required className={FELT} />
        <span className={HJAELP}>Alle uden login må tilsammen bruge denne andel af døgnloftet, så indloggede altid har budget tilbage.</span>
      </label>
      <label className={ETIKET}>
        Loft pr. bruger pr. døgn (USD)
        <input name="bruger_loft_usd" defaultValue={komma(p.brugerLoftUsd)} inputMode="decimal" required className={FELT} />
        <span className={HJAELP}>Brugeren får en besked med et link til kontaktformularen.</span>
      </label>
      <label className={ETIKET}>
        Beskeder uden login pr. døgn (alle samlet)
        <input name="doegnloft_anon" defaultValue={String(p.doegnloftAnon)} inputMode="numeric" required className={FELT} />
      </label>
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending || !hydreret} aria-busy={pending || undefined} className="btn btn-primaer btn-lille">
          {pending && <span className="btn-spinner" aria-hidden="true" />}
          Gem lofter
        </button>
        {besked && (
          <p role={besked.fejl ? "alert" : "status"} className={`mt-2 text-sm font-medium ${besked.fejl ? "text-fejl-tekst" : "text-succes-tekst"}`}>
            {besked.tekst}
          </p>
        )}
      </div>
    </form>
  );
}
