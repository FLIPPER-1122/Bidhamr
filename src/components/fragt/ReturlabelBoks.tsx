"use client";

// Returlabel i en sag (køberen) - kun når FRAGT_RETURLABEL_AKTIV=true (tjekkes
// på serveren i HandelDetalje og i opretReturForsendelse). Køberen udfylder
// sin adresse og sit mobilnummer og får en labelfri kode (DAO) og evt. en
// PDF-label. Pakken sendes til en pakkeshop tæt på sælgeren (fragtfirmaet
// vælger den). Fejl fra serveren er danske og vises direkte.
import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Ikon from "@/components/Ikon";
import SporingTidslinje from "@/components/fragt/SporingTidslinje";
import { hentFragtlabelLink, lavReturlabelAction } from "@/app/actions/fragt";
import type { ForsendelseVisning } from "@/lib/fragt/handlinger";
import { slaaPostnummerOp } from "@/lib/postnumre";
import { useHydreret } from "@/lib/useHydreret";

type Afsender = { navn: string; adresse: string; postnummer: string; by: string; telefon: string };
type FeltFejl = Partial<Record<keyof Afsender, string>>;

const feltKlasse = (fejl: boolean) =>
  `h-11 w-full rounded-xl border bg-white px-4 text-[15px] text-tekst placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-groen/25 disabled:cursor-not-allowed disabled:bg-[#F7F7F7] ${
    fejl ? "border-fejl-kant bg-fejl-bg/40" : "border-kant-staerk hover:border-[#BFBFBF]"
  }`;

function valider(a: Afsender): FeltFejl {
  const f: FeltFejl = {};
  if (a.navn.trim().length < 2) f.navn = "Skriv dit fulde navn.";
  if (a.adresse.trim().length < 3) f.adresse = "Skriv vejnavn og husnummer.";
  if (!slaaPostnummerOp(a.postnummer)) f.postnummer = "Skriv et gyldigt dansk postnummer (4 cifre).";
  if (!a.by.trim()) f.by = "Skriv byen.";
  const tlf = a.telefon.replace(/[\s().-]/g, "");
  if (!/^(\d{8}|(\+|00)\d{8,14})$/.test(tlf)) f.telefon = "Skriv dit mobilnummer (8 cifre).";
  return f;
}

export default function ReturlabelBoks({
  tradeId,
  retur,
  navn,
}: {
  tradeId: string;
  // Den aktive returforsendelse (ikke annulleret), eller null.
  retur: ForsendelseVisning | null;
  // Forudfyldning (profilens navn).
  navn: string;
}) {
  const id = useId();
  const router = useRouter();
  const hydreret = useHydreret();
  const [a, setA] = useState<Afsender>({ navn, adresse: "", postnummer: "", by: "", telefon: "" });
  const [feltFejl, setFeltFejl] = useState<FeltFejl>({});
  const [fejl, setFejl] = useState<string | null>(null);
  const [arbejder, setArbejder] = useState(false);
  const laas = useRef(false);

  function saet<K extends keyof Afsender>(k: K, v: string) {
    setA((x) => {
      const ny = { ...x, [k]: v };
      if (k === "postnummer") {
        const o = slaaPostnummerOp(v);
        if (o && (!x.by || slaaPostnummerOp(x.postnummer)?.by === x.by)) ny.by = o.by;
      }
      return ny;
    });
    if (feltFejl[k]) setFeltFejl((f) => ({ ...f, [k]: undefined }));
  }

  async function lav() {
    if (laas.current) return;
    laas.current = true;
    setArbejder(true);
    setFejl(null);
    try {
      const r = await lavReturlabelAction(tradeId, a);
      if ("fejl" in r) setFejl(r.fejl);
      else router.refresh();
    } catch {
      setFejl("Noget gik galt. Prøv igen om lidt.");
    } finally {
      laas.current = false;
      setArbejder(false);
    }
  }

  async function aabnLabel(fid: string) {
    setFejl(null);
    const vindue = window.open("", "_blank");
    if (vindue) vindue.opener = null;
    try {
      const r = await hentFragtlabelLink(fid);
      if ("fejl" in r) {
        vindue?.close();
        setFejl(r.fejl);
      } else if (vindue) vindue.location.href = r.url;
      else window.location.href = r.url;
    } catch {
      vindue?.close();
      setFejl("Noget gik galt. Prøv igen om lidt.");
    }
  }

  const fejlBoks = fejl && (
    <div role="alert" className="mt-4 rounded-xl border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
      {fejl}
    </div>
  );

  if (retur && retur.status !== "opretter" && retur.status !== "annulleres") {
    return (
      <section aria-labelledby={`${id}-titel`} className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
        <h2 id={`${id}-titel`} className="text-[17px] leading-snug lg:text-lg">
          Din returlabel er klar
        </h2>
        {retur.labelfriKode && (
          <div className="mt-4 rounded-xl bg-groen-lys p-4 text-center sm:p-5">
            <p className="text-sm font-semibold text-groen-mork">Vis denne kode i en daoSHOP</p>
            <p
              className="mt-2 font-mono text-[28px] leading-tight font-bold tracking-[0.08em] break-all text-tekst sm:text-[34px]"
              aria-label={`Labelfri-kode: ${retur.labelfriKode.split("").join(" ")}`}
            >
              {retur.labelfriKode}
            </p>
            <p className="mx-auto mt-2 max-w-[44ch] text-[13px] text-tekst-daempet">
              Du behøver ikke en printer. Vis koden, når du afleverer pakken i en daoSHOP. Pakken sendes til en
              pakkeshop tæt på sælgeren.
            </p>
          </div>
        )}
        {retur.harLabel && (
          <button type="button" onClick={() => void aabnLabel(retur.id)} className="btn btn-sekundaer mt-4 w-full sm:w-auto">
            <Ikon navn="hent" className="h-[18px] w-[18px]" />
            Hent label (PDF)
          </button>
        )}
        {fejlBoks}
        <div className="mt-5 border-t border-kant pt-4">
          <h3 className="mb-3 text-[15px] font-semibold text-tekst">Sporing</h3>
          <SporingTidslinje f={retur} />
        </div>
      </section>
    );
  }

  if (retur) {
    return (
      <section className="rounded-[14px] border border-info-kant bg-info-bg p-5 text-sm text-info-tekst sm:p-6">
        <h2 className="text-[17px] leading-snug lg:text-lg">Returlabelen er ved at blive lavet</h2>
        <p className="mt-1">Fragtfirmaet har ikke svaret endnu. Vent et minut, og prøv igen.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" onClick={() => void lav()} disabled={arbejder || !hydreret} className="btn btn-primaer w-full sm:w-auto">
            {arbejder && <span className="btn-spinner" aria-hidden="true" />}
            Prøv igen
          </button>
        </div>
        {fejlBoks}
      </section>
    );
  }

  return (
    <section aria-labelledby={`${id}-titel`} className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
      <h2 id={`${id}-titel`} className="text-[17px] leading-snug lg:text-lg">
        Lav returlabel
      </h2>
      <p className="mt-1 text-sm text-tekst-svag">
        Du får en kode, som du viser i en daoSHOP, når du afleverer pakken. Pakken sendes til en pakkeshop tæt på
        sælgeren.
      </p>
      <form
        method="post"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const f = valider(a);
          setFeltFejl(f);
          const foerste = (Object.keys(f) as (keyof Afsender)[])[0];
          if (foerste) {
            document.getElementById(`${id}-${foerste}`)?.focus();
            return;
          }
          void lav();
        }}
        className="mt-5"
      >
        <fieldset className="min-w-0" disabled={arbejder}>
          <legend className="mb-2 text-sm font-medium text-tekst">Din adresse (afsender)</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ["navn", "Fulde navn", "name", "sm:col-span-2"],
                ["adresse", "Adresse", "street-address", "sm:col-span-2"],
                ["postnummer", "Postnummer", "postal-code", ""],
                ["by", "By", "address-level2", ""],
                ["telefon", "Mobilnummer", "tel", "sm:col-span-2"],
              ] as const
            ).map(([k, label, auto, kl]) => (
              <div key={k} className={kl}>
                <label htmlFor={`${id}-${k}`} className="mb-1.5 block text-sm font-medium text-tekst">
                  {label}
                </label>
                <input
                  id={`${id}-${k}`}
                  aria-invalid={feltFejl[k] ? true : undefined}
                  aria-describedby={feltFejl[k] ? `${id}-${k}-fejl` : undefined}
                  autoComplete={auto}
                  inputMode={k === "postnummer" ? "numeric" : k === "telefon" ? "tel" : undefined}
                  type={k === "telefon" ? "tel" : "text"}
                  maxLength={k === "postnummer" ? 4 : k === "telefon" ? 20 : k === "by" ? 80 : 100}
                  value={a[k]}
                  onChange={(e) =>
                    saet(k, k === "postnummer" ? e.target.value.replace(/\D/g, "").slice(0, 4) : e.target.value)
                  }
                  className={feltKlasse(!!feltFejl[k])}
                />
                {feltFejl[k] && (
                  <p id={`${id}-${k}-fejl`} className="mt-1.5 text-[13px] font-medium text-fejl-tekst">
                    {feltFejl[k]}
                  </p>
                )}
              </div>
            ))}
          </div>
        </fieldset>
        {fejlBoks}
        <button
          type="submit"
          disabled={arbejder || !hydreret}
          aria-busy={arbejder || undefined}
          className="btn btn-primaer mt-5 w-full sm:w-auto"
        >
          {arbejder && <span className="btn-spinner" aria-hidden="true" />}
          Lav returlabel
        </button>
      </form>
    </section>
  );
}
