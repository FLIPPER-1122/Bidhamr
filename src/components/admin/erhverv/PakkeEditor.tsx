"use client";

// Pakker i Admin → Erhverv. Kun chef kan oprette og ændre (gemErhvervPakke
// kræver chef, og databasen tjekker det igen). Saelger ser listen.
// Ændres pris eller antal auktioner på en pakke, som firmaer bruger, vises en
// advarsel før der gemmes: ændringen gælder for dem med det samme.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { gemErhvervPakke, type ErhvervPakkeAdmin } from "@/app/actions/adminErhverv";
import { ADMIN_FELT, ADMIN_LABEL } from "@/components/admin/erhverv/FirmaFelter";
import { ADMIN_ERHVERV as A, ADMIN_ERHVERV_EKSTRA as X } from "@/lib/tekster/erhverv";
import { ERHVERV_GRAENSER as G } from "@/lib/erhverv/regler";

type Kladde = {
  id: string | null;
  navn: string;
  beskrivelse: string;
  pris: string;
  auktioner: string;
  aktiv: boolean;
  sortering: string;
};

const NY: Kladde = { id: null, navn: "", beskrivelse: "", pris: "", auktioner: "1", aktiv: true, sortering: "0" };

function fraPakke(p: ErhvervPakkeAdmin): Kladde {
  return {
    id: p.id,
    navn: p.navn,
    beskrivelse: p.beskrivelse ?? "",
    pris: p.maanedspris == null ? "" : String(p.maanedspris),
    auktioner: String(p.auktioner_pr_uge),
    aktiv: p.aktiv,
    sortering: String(p.sortering ?? 0),
  };
}

export default function PakkeEditor({ pakker, erChef }: { pakker: ErhvervPakkeAdmin[]; erChef: boolean }) {
  const router = useRouter();
  const [kladde, setKladde] = useState<Kladde | null>(null);
  const [advarsel, setAdvarsel] = useState<number | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const [gemt, setGemt] = useState(false);
  const [gemmer, start] = useTransition();

  function valider(k: Kladde): string | null {
    if (!k.navn.trim()) return A.pakker.fejl.navnMangler;
    if (k.pris.trim() !== "" && !/^\d+$/.test(k.pris.trim())) return A.pakker.fejl.prisUgyldig;
    if (!/^\d+$/.test(k.auktioner.trim()) || Number(k.auktioner) < 1) return A.pakker.fejl.auktionerUgyldigt;
    return null;
  }

  function gem(k: Kladde, bekraeftet: boolean) {
    setFejl(null);
    setGemt(false);
    const f = valider(k);
    if (f) return setFejl(f);
    const original = k.id ? pakker.find((p) => p.id === k.id) : null;
    const pris = k.pris.trim() === "" ? null : Number(k.pris);
    const antal = Number(k.auktioner);
    if (
      !bekraeftet &&
      original &&
      original.antal_firmaer > 0 &&
      (original.maanedspris !== pris || original.auktioner_pr_uge !== antal)
    ) {
      setAdvarsel(original.antal_firmaer);
      return;
    }
    start(async () => {
      const svar = await gemErhvervPakke({
        id: k.id,
        navn: k.navn,
        beskrivelse: k.beskrivelse || null,
        maanedspris: pris,
        auktionerPrUge: antal,
        aktiv: k.aktiv,
        sortering: Number.parseInt(k.sortering, 10) || 0,
      });
      setAdvarsel(null);
      if ("fejl" in svar) return setFejl(svar.fejl);
      setKladde(null);
      setGemt(true);
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      {!erChef && (
        <p className="rounded-lg border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">{A.pakker.kunChef}</p>
      )}
      {gemt && (
        <p role="status" className="rounded-lg border border-succes-kant bg-succes-bg px-4 py-3 text-sm font-medium text-succes-tekst">
          {A.pakker.gemt}
        </p>
      )}

      {pakker.length === 0 ? (
        <p className="rounded-xl border border-neutral-200 bg-white p-8 text-center text-neutral-500">{A.pakker.tom}</p>
      ) : (
        <ul className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200 bg-white">
          {pakker.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-semibold text-neutral-900">
                  {p.navn}
                  {!p.aktiv && (
                    <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-700">{X.skjult}</span>
                  )}
                </p>
                <p className="text-sm text-neutral-600">
                  {A.pakker.feltAuktioner}: {p.auktioner_pr_uge} · {A.pakker.feltPris}:{" "}
                  {p.maanedspris == null ? X.prisIkkeSat : `${p.maanedspris.toLocaleString("da-DK")} kr.`} ·{" "}
                  {X.antalFirmaer(p.antal_firmaer)}
                </p>
                {p.beskrivelse && <p className="mt-1 text-sm text-neutral-500">{p.beskrivelse}</p>}
              </div>
              {erChef && (
                <button
                  type="button"
                  onClick={() => {
                    setKladde(fraPakke(p));
                    setFejl(null);
                    setAdvarsel(null);
                    setGemt(false);
                  }}
                  className="btn btn-sekundaer shrink-0"
                >
                  {X.knapRet}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {erChef && !kladde && (
        <button type="button" onClick={() => setKladde(NY)} className="btn btn-primaer">
          {A.pakker.knapNy}
        </button>
      )}

      {erChef && kladde && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            gem(kladde, false);
          }}
          noValidate
          className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5"
        >
          <h3 className="font-sans text-base font-semibold text-neutral-900">{kladde.id ? `${X.knapRet}: ${kladde.navn}` : A.pakker.knapNy}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="pakke-navn" className={ADMIN_LABEL}>{A.pakker.feltNavn}</label>
              <input id="pakke-navn" value={kladde.navn} maxLength={G.pakkeNavn} placeholder={A.pakker.feltNavnPladsholder}
                onChange={(e) => setKladde({ ...kladde, navn: e.target.value })} className={ADMIN_FELT} />
            </div>
            <div>
              <label htmlFor="pakke-pris" className={ADMIN_LABEL}>{A.pakker.feltPris}</label>
              <input id="pakke-pris" inputMode="numeric" value={kladde.pris} aria-describedby="pakke-pris-hjaelp"
                onChange={(e) => setKladde({ ...kladde, pris: e.target.value.replace(/\D/g, "").slice(0, 7) })} className={ADMIN_FELT} />
              <p id="pakke-pris-hjaelp" className="mt-1.5 text-[13px] text-tekst-daempet">{X.prisTomHjaelp}</p>
            </div>
            <div>
              <label htmlFor="pakke-antal" className={ADMIN_LABEL}>{A.pakker.feltAuktioner}</label>
              <input id="pakke-antal" inputMode="numeric" value={kladde.auktioner}
                onChange={(e) => setKladde({ ...kladde, auktioner: e.target.value.replace(/\D/g, "").slice(0, 4) })} className={ADMIN_FELT} />
            </div>
            <div>
              <label htmlFor="pakke-sortering" className={ADMIN_LABEL}>{X.feltSortering}</label>
              <input id="pakke-sortering" inputMode="numeric" value={kladde.sortering} aria-describedby="pakke-sortering-hjaelp"
                onChange={(e) => setKladde({ ...kladde, sortering: e.target.value.replace(/[^\d-]/g, "").slice(0, 5) })} className={ADMIN_FELT} />
              <p id="pakke-sortering-hjaelp" className="mt-1.5 text-[13px] text-tekst-daempet">{X.feltSorteringHjaelp}</p>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="pakke-beskrivelse" className={ADMIN_LABEL}>{X.feltBeskrivelse}</label>
              <textarea id="pakke-beskrivelse" rows={3} value={kladde.beskrivelse} maxLength={G.pakkeBeskrivelse}
                onChange={(e) => setKladde({ ...kladde, beskrivelse: e.target.value })}
                className="min-h-[90px] w-full rounded-xl border border-kant-staerk bg-white px-4 py-3 text-[15px] focus:border-groen focus:outline-2 focus:outline-groen/25" />
            </div>
          </div>
          <label className="flex min-h-11 cursor-pointer items-start gap-3">
            <input type="checkbox" checked={kladde.aktiv} onChange={(e) => setKladde({ ...kladde, aktiv: e.target.checked })}
              className="mt-0.5 h-5 w-5 accent-groen" />
            <span>
              <span className="block text-[15px] font-medium text-tekst">{A.pakker.feltAktiv}</span>
              <span className="block text-[13px] text-tekst-daempet">{A.pakker.feltAktivHjaelp}</span>
            </span>
          </label>

          {fejl && (
            <p role="alert" className="rounded-lg border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">{fejl}</p>
          )}

          {advarsel !== null ? (
            <div role="alertdialog" aria-labelledby="pakke-advarsel" className="rounded-xl border border-advarsel-kant bg-advarsel-bg p-4 text-advarsel-tekst">
              <p id="pakke-advarsel" className="font-semibold">{X.pakkeBrugesTitel}</p>
              <p className="mt-1 text-sm">{X.pakkeBruges(advarsel)}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => gem(kladde, true)} disabled={gemmer} aria-busy={gemmer || undefined} className="btn btn-primaer">
                  {gemmer && <span className="btn-spinner" aria-hidden="true" />}
                  {X.knapGemAlligevel}
                </button>
                <button type="button" onClick={() => setAdvarsel(null)} disabled={gemmer} className="btn btn-sekundaer">
                  {X.knapAnnuller}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={gemmer} aria-busy={gemmer || undefined} className="btn btn-primaer">
                {gemmer && <span className="btn-spinner" aria-hidden="true" />}
                {A.pakker.knapGem}
              </button>
              <button type="button" onClick={() => setKladde(null)} disabled={gemmer} className="btn btn-sekundaer">
                {X.knapAnnuller}
              </button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
