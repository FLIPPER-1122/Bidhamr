"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { gemMineSkatteoplysninger } from "@/app/actions/dac7";
import { DAC7 } from "@/lib/dac7/tekster";
import { EU_LANDE } from "@/lib/dac7/regler";
import { FELT, FELT_FEJL, FORMULAR_FEJL, LABEL, SUCCES_BOKS } from "@/components/konto/felter";

// Sælgerens DAC7-oplysninger. CPR-feltet vises aldrig udfyldt: det gemte
// CPR-nummer står kun maskeret (fødselsdato-delen), og feltet sendes kun,
// hvis sælgeren skriver et nyt.
type Props = {
  navn: string | null;
  foedselsdato: string | null;
  adresse: string;
  postnummer: string;
  bynavn: string;
  cprMaske: string | null;
  harCpr: boolean;
  andetTinLand: string | null;
};

// true først, når siden er hydreret i browseren. Indtil da er knappen slået
// fra: ellers kunne formularen sendes som en almindelig GET, og CPR-nummeret
// ville ende i adressen (browserhistorik og serverlogs).
const ingenAbonnement = () => () => {};
function useHydreret(): boolean {
  return useSyncExternalStore(ingenAbonnement, () => true, () => false);
}

function foedselsdatoTekst(iso: string | null): string {
  if (!iso) return "–";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

export default function SkatteoplysningerForm(p: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fejl, setFejl] = useState<{ tekst: string; felt?: string } | null>(null);
  const [gemt, setGemt] = useState(false);
  const [visAndet, setVisAndet] = useState(false);
  const [fjernAndet, setFjernAndet] = useState(false);
  const hydreret = useHydreret();
  const fejlRef = useRef<HTMLParagraphElement>(null);
  // DESIGN.md 8.3: fokus flyttes til fejlen ved en mislykket indsendelse.
  useEffect(() => {
    if (fejl) fejlRef.current?.focus();
  }, [fejl]);

  // onSubmit (ikke form action): en form action nulstiller alle felter
  // bagefter, så sælgeren ville miste det udfyldte ved en fejl.
  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    setFejl(null);
    setGemt(false);
    // Et gemt andet skatte-id beholdes, medmindre sælgeren skriver et nyt
    // eller fjerner det.
    const nytAndet = String(formData.get("andetTinNummer") ?? "").trim() !== "";
    formData.set("beholdAndetTin", p.andetTinLand && !fjernAndet && !nytAndet ? "ja" : "nej");
    startTransition(async () => {
      const res = await gemMineSkatteoplysninger(formData);
      if ("ok" in res) {
        // CPR og andet skatte-id skal ikke blive stående i feltet.
        for (const navn of ["cpr", "andetTinNummer"]) {
          const felt = form.elements.namedItem(navn);
          if (felt instanceof HTMLInputElement) felt.value = "";
        }
        setGemt(true);
        setVisAndet(false);
        setFjernAndet(false);
        router.refresh();
      } else {
        setFejl({ tekst: res.fejl, felt: res.felt });
      }
    });
  }

  const fk = (felt: string) => (fejl?.felt === felt ? FELT_FEJL : "");
  // Feltet med fejlen peger på fejlteksten (skærmlæsere læser den op).
  const beskrevet = (felt: string, hjaelp?: string) =>
    [hjaelp, fejl?.felt === felt ? "dac7-fejl" : null].filter(Boolean).join(" ") || undefined;
  const afkryds = "flex min-h-11 cursor-pointer items-start gap-3 py-2.5 text-sm";
  const boks = "mt-0.5 h-5 w-5 shrink-0 rounded-[6px] accent-groen";

  return (
    <form onSubmit={indsend} method="post" className="space-y-4" noValidate>
      <dl className="grid gap-3 rounded-xl bg-groen-lys p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-tekst-daempet">{DAC7.navn}</dt>
          <dd className="font-medium text-tekst">{p.navn ?? "–"}</dd>
        </div>
        <div>
          <dt className="text-tekst-daempet">{DAC7.foedselsdato}</dt>
          <dd className="font-medium text-tekst">{foedselsdatoTekst(p.foedselsdato)}</dd>
        </div>
      </dl>

      <div>
        <label htmlFor="dac7-adresse" className={LABEL}>
          {DAC7.adresse}
        </label>
        <input
          id="dac7-adresse"
          name="adresse"
          type="text"
          autoComplete="street-address"
          maxLength={200}
          defaultValue={p.adresse}
          aria-invalid={fejl?.felt === "adresse" || undefined}
          aria-describedby={beskrevet("adresse", "dac7-adresse-hjaelp")}
          className={`mt-1.5 ${FELT} ${fk("adresse")}`}
        />
        <p id="dac7-adresse-hjaelp" className="mt-1.5 text-[13px] text-tekst-daempet">{DAC7.adresseHjaelp}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
        <div>
          <label htmlFor="dac7-postnummer" className={LABEL}>
            {DAC7.postnummer}
          </label>
          <input
            id="dac7-postnummer"
            name="postnummer"
            type="text"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={4}
            defaultValue={p.postnummer}
            aria-invalid={fejl?.felt === "postnummer" || undefined}
            aria-describedby={beskrevet("postnummer")}
            className={`mt-1.5 ${FELT} ${fk("postnummer")}`}
          />
        </div>
        <div>
          <label htmlFor="dac7-by" className={LABEL}>
            {DAC7.bynavn}
          </label>
          <input
            id="dac7-by"
            name="bynavn"
            type="text"
            autoComplete="address-level2"
            maxLength={100}
            defaultValue={p.bynavn}
            aria-invalid={fejl?.felt === "bynavn" || undefined}
            aria-describedby={beskrevet("bynavn")}
            className={`mt-1.5 ${FELT} ${fk("bynavn")}`}
          />
        </div>
      </div>

      <div>
        <label htmlFor="dac7-cpr" className={LABEL}>
          {DAC7.cpr}
        </label>
        <input
          id="dac7-cpr"
          name="cpr"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          maxLength={11}
          placeholder={p.harCpr ? (p.cprMaske ?? "••••••-••••") : "DDMMÅÅ-XXXX"}
          aria-invalid={fejl?.felt === "cpr" || undefined}
          aria-describedby={beskrevet("cpr", "dac7-cpr-hjaelp")}
          className={`mt-1.5 ${FELT} ${fk("cpr")}`}
        />
        <p id="dac7-cpr-hjaelp" className="mt-1.5 text-[13px] text-tekst-daempet">
          {p.harCpr && p.cprMaske ? `${DAC7.cprGemt(p.cprMaske)} ` : ""}
          {DAC7.cprHjaelp}
        </p>
      </div>

      <div className="rounded-xl border border-kant p-4">
        {p.andetTinLand && !fjernAndet && !visAndet ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {DAC7.andetTinSpm} <strong>{EU_LANDE.find((l) => l.kode === p.andetTinLand)?.navn ?? p.andetTinLand}</strong>
            </span>
            <span className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-sekundaer" onClick={() => setVisAndet(true)}>
                Ret
              </button>
              <button type="button" className="btn btn-sekundaer" onClick={() => setFjernAndet(true)}>
                {DAC7.andetTinFjern}
              </button>
            </span>
          </div>
        ) : visAndet ? (
          <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
            <div>
              <label htmlFor="dac7-andet-land" className={LABEL}>
                {DAC7.andetTinLand}
              </label>
              <select
                id="dac7-andet-land"
                name="andetTinLand"
                defaultValue={p.andetTinLand ?? ""}
                className={`mt-1.5 ${FELT} ${fk("andetTin")}`}
              >
                <option value="">Vælg land</option>
                {EU_LANDE.map((l) => (
                  <option key={l.kode} value={l.kode}>
                    {l.navn}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="dac7-andet-nummer" className={LABEL}>
                {DAC7.andetTinNummer}
              </label>
              <input
                id="dac7-andet-nummer"
                name="andetTinNummer"
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={30}
                className={`mt-1.5 ${FELT} ${fk("andetTin")}`}
              />
            </div>
          </div>
        ) : (
          <label className={`${afkryds} -my-2.5`}>
            <input type="checkbox" className={boks} onChange={(e) => setVisAndet(e.target.checked)} />
            <span>{DAC7.andetTinSpm}</span>
          </label>
        )}
      </div>

      <label className={afkryds}>
        <input type="checkbox" name="bopaelDk" value="ja" defaultChecked={!!p.adresse} className={boks} />
        <span>{DAC7.bopaelDk}</span>
      </label>

      <label className={afkryds}>
        <input type="checkbox" name="bekraeft" value="ja" className={boks} />
        <span>{DAC7.bekraeft}</span>
      </label>

      {fejl && (
        <p id="dac7-fejl" ref={fejlRef} tabIndex={-1} role="alert" className={`${FORMULAR_FEJL} outline-none`}>
          {fejl.tekst}
        </p>
      )}
      {gemt && (
        <p role="status" className={SUCCES_BOKS}>
          {DAC7.gemt}
        </p>
      )}

      <button type="submit" disabled={pending || !hydreret} aria-busy={pending || undefined} className="btn btn-primaer btn-stor w-full sm:w-auto">
        {/* DESIGN.md 6.6: teksten bliver stående, spinneren viser, at der gemmes. */}
        {pending && <span className="btn-spinner" aria-hidden="true" />}
        {DAC7.gem}
      </button>
    </form>
  );
}
