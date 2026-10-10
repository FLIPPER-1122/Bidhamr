"use client";

import { useState, useTransition, type FormEvent } from "react";
import { gemDac7Indstillinger, hentDac7Indberetningsfil, markerDac7Sendt } from "@/app/actions/adminDac7";
import { FELT as FELT_FAELLES } from "@/components/konto/felter";

// Admin → DAC7 (kun chef): klientdelene. Filen hentes via en server action
// og gemmes direkte i chefens browser (den ligger ingen andre steder).

// Felter og etiketter som resten af siden (DESIGN.md 8). Etiketten står over
// feltet; selve feltet ligger inde i <label>, så klik på teksten virker.
const FELT = `mt-1.5 ${FELT_FAELLES} font-normal disabled:cursor-not-allowed disabled:border-kant disabled:bg-[#F7F7F7] disabled:text-tekst-svag`;
const ETIKET = "block text-sm font-medium text-tekst";
const STATUS = (fejl: boolean) => `mt-2 text-sm font-medium ${fejl ? "text-fejl-tekst" : "text-succes-tekst"}`;

export function Dac7FilKnap({ aar, deaktiveret }: { aar: number; deaktiveret?: boolean }) {
  const [pending, start] = useTransition();
  const [besked, setBesked] = useState<{ fejl: boolean; tekst: string } | null>(null);

  function hent() {
    setBesked(null);
    start(async () => {
      const res = await hentDac7Indberetningsfil(aar);
      if ("fejl" in res) {
        setBesked({ fejl: true, tekst: res.fejl });
        return;
      }
      const url = URL.createObjectURL(new Blob([res.fil], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filnavn;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const advarsler = [
        res.ufuldstaendige > 0 ? `${res.ufuldstaendige} sælger(e) mangler oplysninger (dummy-værdier i filen)` : "",
        res.ulaeselige > 0 ? `${res.ulaeselige} skatte-id kunne ikke dekrypteres (forkert nøgle?)` : "",
      ].filter(Boolean);
      setBesked({
        fejl: advarsler.length > 0,
        tekst: `Filen er hentet (${res.antal} sælgere).${advarsler.length ? " OBS: " + advarsler.join("; ") + "." : ""}`,
      });
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={hent}
        disabled={pending || deaktiveret}
        aria-busy={pending || undefined}
        className="btn btn-primaer h-auto min-h-11 py-2.5 text-left"
      >
        {pending && <span className="btn-spinner" aria-hidden="true" />}
        Hent indberetningsfil (Skattestyrelsens CSV)
      </button>
      {deaktiveret && !pending && (
        <p className="mt-1.5 text-[13px] text-tekst-daempet">Udfyld BidHamrs CVR-nummer under Indstillinger først.</p>
      )}
      {besked && (
        <p role={besked.fejl ? "alert" : "status"} className={STATUS(besked.fejl)}>
          {besked.tekst}
        </p>
      )}
    </div>
  );
}

type Indstillinger = {
  aar: number;
  kurs: number;
  cvr: string;
  navn: string;
  vej: string;
  postnummer: string;
  bynavn: string;
  kontakt: string;
  laast: boolean;
};

export function Dac7IndstillingerForm(p: Indstillinger) {
  const [pending, start] = useTransition();
  const [besked, setBesked] = useState<{ fejl: boolean; tekst: string } | null>(null);

  function gem(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBesked(null);
    start(async () => {
      const res = await gemDac7Indstillinger(fd);
      setBesked("fejl" in res ? { fejl: true, tekst: res.fejl } : { fejl: false, tekst: "Gemt." });
    });
  }

  return (
    <form onSubmit={gem} method="post" className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="aar" value={p.aar} />
      <label className={ETIKET}>
        BidHamrs CVR-nummer
        <input name="cvr" defaultValue={p.cvr} inputMode="numeric" maxLength={8} className={FELT} />
      </label>
      <label className={ETIKET}>
        Juridisk navn
        <input name="navn" defaultValue={p.navn} maxLength={200} className={FELT} />
      </label>
      <label className={ETIKET}>
        Vej og husnummer (registreret adresse)
        <input name="vej" defaultValue={p.vej} maxLength={200} className={FELT} />
      </label>
      <div className="grid grid-cols-[100px_1fr] gap-3">
        <label className={ETIKET}>
          Postnr.
          <input name="postnummer" defaultValue={p.postnummer} inputMode="numeric" maxLength={4} className={FELT} />
        </label>
        <label className={ETIKET}>
          By
          <input name="bynavn" defaultValue={p.bynavn} maxLength={100} className={FELT} />
        </label>
      </div>
      <label className={ETIKET}>
        Kontakt (navn, e-mail - står i filen)
        <input name="kontakt" defaultValue={p.kontakt} maxLength={200} className={FELT} />
      </label>
      <label className={ETIKET}>
        Kurs {p.aar} (DKK pr. EUR)
        <input
          name="kurs"
          defaultValue={String(p.kurs).replace(".", ",")}
          inputMode="decimal"
          disabled={p.laast}
          className={FELT}
        />
      </label>
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending || undefined}
          className="btn btn-sekundaer"
        >
          {pending && <span className="btn-spinner" aria-hidden="true" />}
          Gem indstillinger
        </button>
        {besked && (
          <p role={besked.fejl ? "alert" : "status"} className={STATUS(besked.fejl)}>
            {besked.tekst}
          </p>
        )}
      </div>
    </form>
  );
}

export type Dac7Eksport = { id: string; oprettet_kl: string; antal: number; har_hash: boolean };

// SHA-256 (hex) af filen - beregnes i browseren. Selve filen (med CPR-numre)
// sendes ALDRIG til serveren; kun hashen.
async function sha256Hex(fil: File): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", await fil.arrayBuffer());
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function Dac7SendtForm({ aar, eksporter }: { aar: number; eksporter: Dac7Eksport[] }) {
  const [pending, start] = useTransition();
  const [fejl, setFejl] = useState<string | null>(null);
  const [sikker, setSikker] = useState(false);
  const brugbare = eksporter.filter((e) => e.har_hash);

  function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const filFelt = form.querySelector<HTMLInputElement>("input[type=file]");
    const fil = filFelt?.files?.[0];
    const fd = new FormData();
    fd.set("aar", String(aar));
    fd.set("eksport", String(new FormData(form).get("eksport") ?? ""));
    fd.set("kvittering", String(new FormData(form).get("kvittering") ?? ""));
    setFejl(null);
    if (!fil) {
      setFejl("Vælg den fil, du har uploadet til Skattestyrelsen.");
      return;
    }
    start(async () => {
      fd.set("hash", await sha256Hex(fil));
      const res = await markerDac7Sendt(fd);
      if ("fejl" in res) setFejl(res.fejl);
    });
  }

  if (brugbare.length === 0) {
    return <p className="text-sm text-tekst-daempet">Hent indberetningsfilen først (trin 2).</p>;
  }

  return (
    <form onSubmit={send} method="post" className="space-y-4">
      <label className={ETIKET}>
        Hvilken fil har du uploadet?
        <select name="eksport" className={FELT} defaultValue={brugbare[0].id}>
          {brugbare.map((e) => (
            <option key={e.id} value={e.id}>
              {new Date(e.oprettet_kl).toLocaleString("da-DK", { timeZone: "Europe/Copenhagen" })} ({e.antal} sælgere)
            </option>
          ))}
        </select>
      </label>
      <label className={ETIKET}>
        Vælg samme fil igen (den bliver ikke sendt – vi tjekker kun, at det er den rigtige)
        <input type="file" accept=".csv,text/csv" className={`${FELT} py-2.5 file:mr-3 file:rounded-lg file:border-0 file:bg-groen-lys file:px-3 file:py-1 file:font-medium file:text-groen-mork`} />
      </label>
      <label className={ETIKET}>
        Kvitteringsnummer fra TastSelv Erhverv
        <input name="kvittering" maxLength={200} required className={FELT} />
      </label>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={sikker}
          onChange={(e) => setSikker(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 rounded-[6px] accent-groen"
        />
        Filen er uploadet og godkendt i TastSelv Erhverv. Sælgerne får nu besked og en kopi under Min konto. Kan ikke
        fortrydes.
      </label>
      <button
        type="submit"
        disabled={pending || !sikker}
        aria-busy={pending || undefined}
        className="btn btn-primaer"
      >
        {pending && <span className="btn-spinner" aria-hidden="true" />}
        Markér som sendt til Skattestyrelsen
      </button>
      {fejl && (
        <p role="alert" className="text-sm font-medium text-fejl-tekst">
          {fejl}
        </p>
      )}
    </form>
  );
}
