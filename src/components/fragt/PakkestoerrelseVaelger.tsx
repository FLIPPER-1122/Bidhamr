"use client";

// Vælger for forsendelse ved opret/redigér auktion: Lille / Mellem / Stor /
// Kun afhentning, med købers fragtpriser fra databasen (fragt_pakkestoerrelser -
// det ene sted, priserne står) og vægtfelt (altid krævet ved forsendelse).
// Databasen håndhæver grænserne igen (BHT01-BHT05).
import { useEffect, useId, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { kroner } from "@/lib/kroner";

export type Fragtstoerrelse = {
  kode: "lille" | "mellem" | "stor";
  navn: string;
  maks_gram: number;
  pakkeshop_oere: number;
  doer_oere: number | null;
};

export type LeveringValg = Fragtstoerrelse["kode"] | "afhentning";

const EKSEMPEL: Record<Fragtstoerrelse["kode"], string> = {
  lille: "Fx tøj, bøger, smykker",
  mellem: "Fx sko, køkkenting, legetøj",
  stor: "Fx elektronik, sportsudstyr",
};

// Ikonets størrelse viser pakkens størrelse.
const IKON_KLASSE: Record<LeveringValg, string> = {
  lille: "h-5 w-5",
  mellem: "h-6 w-6",
  stor: "h-7 w-7",
  afhentning: "h-6 w-6",
};

// Fejlkoder fra databasen ved insert/update af en auktion.
export function fragtFejlTekst(kode: string | undefined | null): string | null {
  if (kode === "BHT01") return "Varer over 15 kg kan kun afhentes. Vælg “Kun afhentning”.";
  if (kode === "BHT02") return "Vægten passer ikke til pakkestørrelsen. Vælg en større pakke.";
  if (kode === "BHT03") return "Skriv, hvor meget pakken vejer.";
  if (kode === "BHT04") return "Angiv en gyldig vægt.";
  if (kode === "BHT05") return "Ukendt pakkestørrelse. Vælg Lille, Mellem eller Stor.";
  return null;
}

// "2,5" -> 2500. null = ugyldig/tom.
export function vaegtTilGram(tekst: string): number | null {
  const t = tekst.trim();
  if (!/^\d+([.,]\d{1,3})?$/.test(t)) return null;
  const g = Math.round(Number(t.replace(",", ".")) * 1000);
  return g > 0 ? g : null;
}

export function vaegtFejl(tekst: string, valgt: Fragtstoerrelse | null, stoerrelser: Fragtstoerrelse[]): string | null {
  if (!tekst.trim()) return "Skriv, hvor meget pakken vejer.";
  const g = vaegtTilGram(tekst);
  if (g === null) return "Skriv vægten i kg, fx 2,5.";
  const stoerst = stoerrelser.reduce((m, s) => Math.max(m, s.maks_gram), 0) || 15000;
  if (g > stoerst) return `Varer over ${stoerst / 1000} kg kan kun afhentes. Vælg “Kun afhentning”.`;
  if (valgt && g > valgt.maks_gram) {
    const passer = stoerrelser.find((s) => g <= s.maks_gram);
    return passer
      ? `Pakken er for tung til ${valgt.navn.toLowerCase()}. Vælg ${passer.navn.toLowerCase()} (op til ${passer.maks_gram / 1000} kg).`
      : "Vægten passer ikke til pakkestørrelsen. Vælg en større pakke.";
  }
  return null;
}

// Pakkestørrelser og priser fra databasen (offentlige data).
export function useFragtstoerrelser() {
  const [data, setData] = useState<Fragtstoerrelse[] | null>(null);
  const [fejl, setFejl] = useState(false);
  useEffect(() => {
    let aktiv = true;
    createClient()
      .from("fragt_pakkestoerrelser")
      .select("kode, navn, maks_gram, pakkeshop_oere, doer_oere")
      .order("sortering", { ascending: true })
      .then(({ data: d, error }) => {
        if (!aktiv) return;
        if (error || !d) setFejl(true);
        else setData(d as Fragtstoerrelse[]);
      });
    return () => {
      aktiv = false;
    };
  }, []);
  return { stoerrelser: data, fejl };
}

function kg(gram: number) {
  return (gram / 1000).toLocaleString("da-DK", { maximumFractionDigits: 1 });
}

export default function PakkestoerrelseVaelger({
  stoerrelser,
  hentFejl = false,
  vaerdi,
  onVaerdi,
  vaegt,
  onVaegt,
  vaegtFejlTekst,
  vaegtId,
  deaktiveret = false,
  afhentningOgsaa,
  onAfhentningOgsaa,
}: {
  stoerrelser: Fragtstoerrelse[] | null;
  hentFejl?: boolean;
  vaerdi: LeveringValg;
  onVaerdi: (v: LeveringValg) => void;
  vaegt: string;
  onVaegt: (v: string) => void;
  vaegtFejlTekst?: string | null;
  vaegtId: string;
  deaktiveret?: boolean;
  // Sælgeren tilbyder også afhentning ved siden af forsendelse
  // (auctions.afhentning_mulig). Vises kun, når onAfhentningOgsaa er givet.
  afhentningOgsaa?: boolean;
  onAfhentningOgsaa?: (v: boolean) => void;
}) {
  const id = useId();
  const valgt = stoerrelser?.find((s) => s.kode === vaerdi) ?? null;
  const valg: { v: LeveringValg; s: Fragtstoerrelse | null }[] = [
    ...(stoerrelser ?? []).map((s) => ({ v: s.kode as LeveringValg, s })),
    { v: "afhentning", s: null },
  ];

  return (
    <div>
      <fieldset className="min-w-0" disabled={deaktiveret}>
        <legend className="mb-1.5 block text-sm font-medium text-tekst">Forsendelse</legend>
        <p id={`${id}-hjaelp`} className="mb-3 text-[13px] text-tekst-daempet">
          Vælg den mindste pakke, varen kan sendes i. Køberen betaler fragten og ser prisen, før der bydes.
          Varer over 15 kg kan kun afhentes.
        </p>
        {stoerrelser === null && !hentFejl ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden="true">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="h-[132px] animate-pulse rounded-xl bg-groen-lys" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {valg.map(({ v, s }) => {
              const er = vaerdi === v;
              return (
                <label
                  key={v}
                  className={`relative flex cursor-pointer flex-col rounded-xl border-2 p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-groen has-[:disabled]:cursor-not-allowed sm:p-4 ${
                    er ? "border-groen bg-groen-lys" : "border-kant bg-white hover:border-kant-staerk"
                  }`}
                >
                  <input
                    type="radio"
                    name={`${id}-levering`}
                    value={v}
                    checked={er}
                    onChange={() => onVaerdi(v)}
                    className="sr-only"
                  />
                  <span className="flex h-8 items-end text-groen-mork" aria-hidden="true">
                    {v === "afhentning" ? (
                      <svg viewBox="0 0 24 24" className={IKON_KLASSE[v]} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0" />
                        <path d="M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" className={IKON_KLASSE[v]} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3l8 4.5v9l-8 4.5l-8 -4.5v-9l8 -4.5" />
                        <path d="M12 12l8 -4.5" />
                        <path d="M12 12v9" />
                        <path d="M12 12l-8 -4.5" />
                      </svg>
                    )}
                  </span>
                  <span className="mt-2 text-[15px] font-semibold text-tekst">{s ? s.navn : "Kun afhentning"}</span>
                  <span className="text-[13px] text-tekst-daempet">
                    {s ? `Op til ${kg(s.maks_gram)} kg` : "Køberen henter hos dig"}
                  </span>
                  <span className="mt-2 text-[13px] leading-snug text-tekst">
                    {s ? (
                      <>
                        <span className="font-semibold">{kroner(s.pakkeshop_oere)}</span> pakkeshop
                        <span className="block text-tekst-daempet">
                          {s.doer_oere ? `${kroner(s.doer_oere)} hjem` : "Kun pakkeshop"}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="font-semibold">0 kr</span> fragt
                        <span className="block text-tekst-daempet">Fx møbler og alt over 15 kg</span>
                      </>
                    )}
                  </span>
                  {er && (
                    <span className="absolute top-2.5 right-2.5 grid h-5 w-5 place-items-center rounded-full bg-groen text-white" aria-hidden="true">
                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={3}>
                        <path d="M5 12l5 5l10 -10" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                  {s && <span className="sr-only">. {EKSEMPEL[s.kode]}</span>}
                </label>
              );
            })}
          </div>
        )}
        {hentFejl && (
          <p className="mt-2 text-[13px] font-medium text-fejl-tekst">
            Fragtpriserne kunne ikke hentes. Genindlæs siden, eller vælg “Kun afhentning”.
          </p>
        )}
        {valgt && <p className="mt-2 text-[13px] text-tekst-daempet">{EKSEMPEL[valgt.kode]}.</p>}
      </fieldset>

      {vaerdi !== "afhentning" && (
        <div className="mt-4">
          <label htmlFor={vaegtId} className="mb-1.5 block text-sm font-medium text-tekst">
            Vægt med emballage
          </label>
          <div className="relative sm:max-w-[200px]">
            <input
              id={vaegtId}
              inputMode="decimal"
              autoComplete="off"
              value={vaegt}
              onChange={(e) => onVaegt(e.target.value)}
              disabled={deaktiveret}
              aria-invalid={vaegtFejlTekst ? true : undefined}
              aria-describedby={`${vaegtId}-hjaelp${vaegtFejlTekst ? ` ${vaegtId}-fejl` : ""}`}
              placeholder="fx 2,5"
              className={`h-11 w-full rounded-xl border bg-white pr-12 pl-4 text-[15px] text-tekst placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-groen/25 ${
                vaegtFejlTekst ? "border-fejl-kant bg-fejl-bg/40" : "border-kant-staerk hover:border-[#BFBFBF]"
              }`}
            />
            <span className="pointer-events-none absolute inset-y-0 right-4 grid place-items-center text-[15px] text-tekst-svag" aria-hidden="true">
              kg
            </span>
          </div>
          <p id={`${vaegtId}-hjaelp`} className="mt-1.5 text-[13px] text-tekst-daempet">
            Vej pakken med kasse og fyld, og skriv den rigtige vægt. Den kommer på fragtlabelen, og
            fragtfirmaet vejer pakken.
          </p>
          {vaegtFejlTekst && (
            <p id={`${vaegtId}-fejl`} className="mt-1.5 text-[13px] font-medium text-fejl-tekst">
              {vaegtFejlTekst}
            </p>
          )}
        </div>
      )}

      {vaerdi !== "afhentning" && onAfhentningOgsaa && (
        <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 text-sm text-tekst has-[:disabled]:cursor-not-allowed">
          <input
            type="checkbox"
            checked={Boolean(afhentningOgsaa)}
            onChange={(e) => onAfhentningOgsaa(e.target.checked)}
            disabled={deaktiveret}
            aria-describedby={`${id}-afhentning-hjaelp`}
            className="mt-0.5 h-5 w-5 shrink-0 rounded-[6px] accent-groen"
          />
          <span>
            <span className="font-medium">Køberen må også hente varen hos mig</span>
            <span id={`${id}-afhentning-hjaelp`} className="block text-[13px] text-tekst-daempet">
              Køberen vælger i checkout mellem forsendelse og afhentning (0 kr. i fragt). Ved afhentning viser
              køberen en kode, og du får pengene, når du har tastet den.
            </span>
          </span>
        </label>
      )}
    </div>
  );
}
