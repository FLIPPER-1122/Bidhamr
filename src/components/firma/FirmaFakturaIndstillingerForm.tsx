"use client";

import { useActionState, useState } from "react";
import { gemFirmaFakturaIndstillinger, type IndstillingerSvar } from "@/app/actions/firmaFaktura";
import { E_FEJL, E_HJAELP, E_KNAP_PRIMAER, E_LABEL, eFelt } from "@/components/erhverv/stil";
import {
  FIRMA_FAKTURA_TEKST as T,
  fakturanummerTekst,
  type FirmaFakturaIndstillinger,
} from "@/lib/erhverv/firmaFaktura";

export default function FirmaFakturaIndstillingerForm({ i, kontaktEmail }: { i: FirmaFakturaIndstillinger; kontaktEmail: string }) {
  const [svar, handling, travl] = useActionState<IndstillingerSvar | null, FormData>(gemFirmaFakturaIndstillinger, null);
  const [praefiks, setPraefiks] = useState(i.praefiks);
  const [start, setStart] = useState(String(i.naeste_nummer));
  const [cifre, setCifre] = useState(String(i.cifre));
  const eksempel = /^\d+$/.test(start) && Number(start) > 0 ? fakturanummerTekst(praefiks, Number(start), Number(cifre) || 1) : "";
  const laast = i.nummer_laast;

  return (
    <form action={handling} className="space-y-6">
      <fieldset className="space-y-4">
        <legend className="text-[20px] font-semibold text-tekst">Nummerserie</legend>
        {laast && (
          <p className={E_HJAELP}>
            Du har sendt en faktura, så præfiks og nummer er låst. Numrene fortsætter uden huller. {T.naesteNummer(i.naeste_fakturanummer)}.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="ff-praefiks" className={E_LABEL}>
              Præfiks
            </label>
            <input id="ff-praefiks" name="praefiks" value={praefiks} onChange={(e) => setPraefiks(e.target.value)} readOnly={laast} maxLength={12} className={eFelt()} />
          </div>
          <div>
            <label htmlFor="ff-start" className={E_LABEL}>
              {laast ? "Næste nummer" : "Startnummer"}
            </label>
            <input id="ff-start" name="startnummer" inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value)} readOnly={laast} className={eFelt()} />
          </div>
          <div>
            <label htmlFor="ff-cifre" className={E_LABEL}>
              Antal cifre
            </label>
            <input id="ff-cifre" name="cifre" inputMode="numeric" value={cifre} onChange={(e) => setCifre(e.target.value)} readOnly={laast} className={eFelt()} />
          </div>
        </div>
        {!laast && eksempel && <p className={E_HJAELP}>Din første faktura får nummer {eksempel}. Fortsætter du en serie fra dit regnskabsprogram, så skriv det næste nummer.</p>}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-[20px] font-semibold text-tekst">Moms på dine salg (standard)</legend>
        <label className="flex items-start gap-3 text-[18px]">
          <input type="radio" name="momsordning" value="moms" defaultChecked={i.momsordning === "moms"} className="mt-1 h-6 w-6" />
          <span>
            Almindelig moms – fakturaen viser beløb ekskl. moms, moms 25 % og total.
          </span>
        </label>
        <label className="flex items-start gap-3 text-[18px]">
          <input type="radio" name="momsordning" value="brugtmoms" defaultChecked={i.momsordning === "brugtmoms"} className="mt-1 h-6 w-6" />
          <span>Brugtmoms – fakturaen viser ingen moms, men teksten &quot;Brugtmoms – særordning for brugte varer&quot;.</span>
        </label>
        <p className={E_HJAELP}>
          Du kan vælge en anden momsordning på den enkelte auktion. Valget låses, når varen er solgt. Spørg din revisor, hvis du er i tvivl.
        </p>
      </fieldset>

      <div>
        <label htmlFor="ff-tekst" className={E_LABEL}>
          Betalingstekst på fakturaen
        </label>
        <input id="ff-tekst" name="betalingstekst" defaultValue={i.betalingstekst} maxLength={200} required className={eFelt()} />
      </div>
      <div>
        <label htmlFor="ff-email" className={E_LABEL}>
          E-mail til svar fra køberen
        </label>
        <input id="ff-email" name="svar_email" type="email" defaultValue={i.svar_email ?? ""} placeholder={kontaktEmail} maxLength={254} className={eFelt()} />
        <p className={E_HJAELP}>Står på fakturaen og er svaradressen på mailen. Du får også en kopi af hver faktura hertil. Tom = {kontaktEmail}.</p>
      </div>
      <label className="flex items-start gap-3 text-[18px]">
        <input type="checkbox" name="vis_logo" defaultChecked={i.vis_logo} className="mt-1 h-6 w-6" />
        <span>Vis dit profilbillede som logo på fakturaen</span>
      </label>

      <button type="submit" disabled={travl} className={E_KNAP_PRIMAER}>
        {travl ? "Gemmer …" : "Gem indstillinger"}
      </button>
      {svar && "fejl" in svar && (
        <p role="alert" className={E_FEJL}>
          {svar.fejl}
        </p>
      )}
      {svar && "ok" in svar && (
        <p role="status" className={E_HJAELP}>
          {T.gemt}
        </p>
      )}
    </form>
  );
}
