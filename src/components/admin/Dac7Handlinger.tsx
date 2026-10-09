"use client";

import { useState, useTransition, type FormEvent } from "react";
import { gemDac7Indstillinger, hentDac7Indberetningsfil, markerDac7Sendt } from "@/app/actions/adminDac7";

// Admin → DAC7 (kun chef): klientdelene. Filen hentes via en server action
// og gemmes direkte i chefens browser (den ligger ingen andre steder).

const FELT = "mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm";

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
        className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Henter …" : "Hent indberetningsfil (Skattestyrelsens CSV)"}
      </button>
      {besked && (
        <p role={besked.fejl ? "alert" : "status"} className={`mt-2 text-sm ${besked.fejl ? "text-red-700" : "text-green-700"}`}>
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
      <label className="text-sm">
        BidHamrs CVR-nummer
        <input name="cvr" defaultValue={p.cvr} inputMode="numeric" maxLength={8} className={FELT} />
      </label>
      <label className="text-sm">
        Juridisk navn
        <input name="navn" defaultValue={p.navn} maxLength={200} className={FELT} />
      </label>
      <label className="text-sm">
        Vej og husnummer (registreret adresse)
        <input name="vej" defaultValue={p.vej} maxLength={200} className={FELT} />
      </label>
      <div className="grid grid-cols-[100px_1fr] gap-3">
        <label className="text-sm">
          Postnr.
          <input name="postnummer" defaultValue={p.postnummer} inputMode="numeric" maxLength={4} className={FELT} />
        </label>
        <label className="text-sm">
          By
          <input name="bynavn" defaultValue={p.bynavn} maxLength={100} className={FELT} />
        </label>
      </div>
      <label className="text-sm">
        Kontakt (navn, e-mail - står i filen)
        <input name="kontakt" defaultValue={p.kontakt} maxLength={200} className={FELT} />
      </label>
      <label className="text-sm">
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
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {pending ? "Gemmer …" : "Gem indstillinger"}
        </button>
        {besked && (
          <p role={besked.fejl ? "alert" : "status"} className={`mt-2 text-sm ${besked.fejl ? "text-red-700" : "text-green-700"}`}>
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
    return <p className="text-sm text-gray-600">Hent indberetningsfilen først (trin 2).</p>;
  }

  return (
    <form onSubmit={send} method="post" className="space-y-2">
      <label className="block text-sm">
        Hvilken fil har du uploadet?
        <select name="eksport" className={FELT} defaultValue={brugbare[0].id}>
          {brugbare.map((e) => (
            <option key={e.id} value={e.id}>
              {new Date(e.oprettet_kl).toLocaleString("da-DK", { timeZone: "Europe/Copenhagen" })} ({e.antal} sælgere)
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Vælg samme fil igen (den bliver ikke sendt – vi tjekker kun, at det er den rigtige)
        <input type="file" accept=".csv,text/csv" className={FELT} />
      </label>
      <label className="block text-sm">
        Kvitteringsnummer fra TastSelv Erhverv
        <input name="kvittering" maxLength={200} required className={FELT} />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={sikker} onChange={(e) => setSikker(e.target.checked)} className="mt-0.5" />
        Filen er uploadet og godkendt i TastSelv Erhverv. Sælgerne får nu besked og en kopi under Min konto. Kan ikke
        fortrydes.
      </label>
      <button
        type="submit"
        disabled={pending || !sikker}
        className="rounded-lg bg-green-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Gemmer …" : "Markér som sendt til Skattestyrelsen"}
      </button>
      {fejl && (
        <p role="alert" className="text-sm text-red-700">
          {fejl}
        </p>
      )}
    </form>
  );
}
