"use client";

// Pakker i Admin → Erhverv. Kun chef kan oprette og ændre (gemErhvervPakke
// kræver chef, og databasen tjekker det igen). Saelger ser listen.
// Pakkerne fra 26. okt. 2026: auktioner pr. kalendermåned (eller ubegrænset),
// fremhævninger pr. måned, statistik, fast kontaktperson og rabat på Ugens
// butik. Arkiverede pakker (Basis/Plus/Pro/Max) vises, men kan ikke ændres.
// Ændres pris eller antal auktioner på en pakke, som firmaer bruger, vises en
// advarsel før der gemmes: ændringen gælder for dem med det samme.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { gemErhvervPakke, type ErhvervPakkeAdmin } from "@/app/actions/adminErhverv";
import { ADMIN_FELT, ADMIN_LABEL } from "@/components/admin/erhverv/FirmaFelter";
import { ADMIN_ERHVERV as A, ADMIN_ERHVERV_EKSTRA as X, ADMIN_PAKKE_EDITOR as P, FIRMA_PAKKER } from "@/lib/tekster/erhverv";
import { ERHVERV_GRAENSER as G } from "@/lib/erhverv/regler";
import { useHydreret } from "@/lib/useHydreret";

type Statistik = "ingen" | "statistik" | "fuld";

type Kladde = {
  id: string | null;
  navn: string;
  beskrivelse: string;
  pris: string;
  ubegraenset: boolean;
  auktioner: string;
  fremh: string;
  statistik: Statistik;
  fastKontakt: boolean;
  ugensProcent: string;
  ugensAntal: string;
  aktiv: boolean;
  sortering: string;
};

// Mellemrum fjernes ("1 000" = 1000). Komma og punktum afvises i valider.
function renPris(s: string): string {
  return s.replace(/\s/g, "");
}

const HELTAL = /^\d+$/;

const NY: Kladde = {
  id: null,
  navn: "",
  beskrivelse: "",
  pris: "",
  ubegraenset: false,
  auktioner: "20",
  fremh: "0",
  statistik: "ingen",
  fastKontakt: false,
  ugensProcent: "0",
  ugensAntal: "0",
  aktiv: true,
  sortering: "0",
};

function fraPakke(p: ErhvervPakkeAdmin): Kladde {
  return {
    id: p.id,
    navn: p.navn,
    beskrivelse: p.beskrivelse ?? "",
    pris: p.maanedspris == null ? "" : String(p.maanedspris),
    ubegraenset: p.ubegraenset,
    auktioner: p.auktioner_pr_maaned == null ? "20" : String(p.auktioner_pr_maaned),
    fremh: String(p.fremhaevninger_pr_maaned ?? 0),
    statistik: p.statistik ?? "ingen",
    fastKontakt: !!p.fast_kontaktperson,
    ugensProcent: String(p.ugens_butik_rabat_procent ?? 0),
    ugensAntal: String(p.ugens_butik_rabat_antal ?? 0),
    aktiv: p.aktiv,
    sortering: String(p.sortering ?? 0),
  };
}

function Afkryds({
  checked,
  onChange,
  titel,
  hjaelp,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  titel: string;
  hjaelp?: string;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-groen" />
      <span>
        <span className="block text-[15px] font-medium text-tekst">{titel}</span>
        {hjaelp && <span className="block text-[13px] text-tekst-daempet">{hjaelp}</span>}
      </span>
    </label>
  );
}

function Hjaelp({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} className="mt-1.5 text-[13px] text-tekst-daempet">
      {children}
    </p>
  );
}

export default function PakkeEditor({ pakker, erChef }: { pakker: ErhvervPakkeAdmin[]; erChef: boolean }) {
  const router = useRouter();
  const [kladde, setKladde] = useState<Kladde | null>(null);
  const [advarsel, setAdvarsel] = useState<number | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const [gemt, setGemt] = useState<string | false>(false);
  const [gemmer, start] = useTransition();
  // Knappen er slået fra, til siden er hydreret (src/lib/useHydreret.ts).
  const hydreret = useHydreret();

  function valider(k: Kladde): string | null {
    if (!k.navn.trim()) return A.pakker.fejl.navnMangler;
    // Kun hele kroner: "99,50" må ikke blive til 9.950 kr.
    if (/[.,]/.test(k.pris)) return A.pakker.fejl.prisHeleKroner;
    if (renPris(k.pris) !== "" && !HELTAL.test(renPris(k.pris))) return A.pakker.fejl.prisUgyldig;
    if (!k.ubegraenset && (!HELTAL.test(k.auktioner.trim()) || Number(k.auktioner) < 1 || Number(k.auktioner) > G.auktionerPrMaanedMaks)) {
      return A.pakker.fejl.auktionerUgyldigt;
    }
    if (!HELTAL.test(k.fremh.trim()) || Number(k.fremh) > 1000) return P.fejl.fremh;
    if (
      !HELTAL.test(k.ugensProcent.trim()) ||
      !HELTAL.test(k.ugensAntal.trim()) ||
      Number(k.ugensProcent) > 90 ||
      Number(k.ugensAntal) > 52
    ) {
      return P.fejl.ugens;
    }
    return null;
  }

  function gem(k: Kladde, bekraeftet: boolean) {
    setFejl(null);
    setGemt(false);
    const f = valider(k);
    if (f) return setFejl(f);
    const original = k.id ? pakker.find((p) => p.id === k.id) : null;
    const pris = renPris(k.pris) === "" ? null : Number(renPris(k.pris));
    // null = ubegrænset (gemErhvervPakke sender p_ubegraenset = true).
    const antal = k.ubegraenset ? null : Number(k.auktioner);
    const originalAntal = original ? (original.ubegraenset ? null : original.auktioner_pr_maaned) : null;
    if (!bekraeftet && original && original.antal_firmaer > 0 && (original.maanedspris !== pris || originalAntal !== antal)) {
      setAdvarsel(original.antal_firmaer);
      return;
    }
    start(async () => {
      const svar = await gemErhvervPakke({
        id: k.id,
        navn: k.navn,
        beskrivelse: k.beskrivelse || null,
        maanedspris: pris,
        auktionerPrMaaned: antal,
        fremhaevningerPrMaaned: Number(k.fremh),
        statistik: k.statistik,
        fastKontaktperson: k.fastKontakt,
        ugensButikRabatProcent: Number(k.ugensProcent),
        ugensButikRabatAntal: Number(k.ugensAntal),
        aktiv: k.aktiv,
        sortering: Number.parseInt(k.sortering, 10) || 0,
      });
      setAdvarsel(null);
      if ("fejl" in svar) return setFejl(svar.fejl);
      setKladde(null);
      setGemt(svar.besked ?? A.pakker.gemt);
      router.refresh();
    });
  }

  const tal = (v: string, maks = 6) => v.replace(/\D/g, "").slice(0, maks);

  return (
    <div className="space-y-5">
      {!erChef && <p className="border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">{A.pakker.kunChef}</p>}
      {gemt && (
        <p role="status" className="border border-succes-kant bg-succes-bg px-4 py-3 text-sm font-medium text-succes-tekst">
          {gemt}
        </p>
      )}

      {pakker.length === 0 ? (
        <p className="border border-kant bg-white p-8 text-center text-tekst-daempet">{A.pakker.tom}</p>
      ) : (
        <ul className="divide-y divide-kant border border-kant bg-white">
          {pakker.map((p) => {
            // Arkiverede pakker har den gamle ugekvote (står i beskrivelsen) -
            // ingen månedskvote, så "ubegrænset" ville være forkert her.
            const dele = [
              p.arkiveret ? null : FIRMA_PAKKER.auktionerPrMaaned(p.ubegraenset ? null : p.auktioner_pr_maaned),
              P.linjePris(p.maanedspris == null ? null : `${p.maanedspris.toLocaleString("da-DK")} kr.`),
              FIRMA_PAKKER.fremhaevningerPrMaaned(p.fremhaevninger_pr_maaned ?? 0),
              P.statistikValg[p.statistik ?? "ingen"],
              p.fast_kontaktperson ? FIRMA_PAKKER.fastKontaktperson : null,
              // Velkomstrabat for nye firmaer (Filip, 27. okt. 2026).
              !p.arkiveret && p.maaned1 ? FIRMA_PAKKER.maaned1[p.maaned1] : null,
              p.ugens_butik_rabat_procent > 0 && p.ugens_butik_rabat_antal > 0
                ? P.linjeUgens(p.ugens_butik_rabat_procent, p.ugens_butik_rabat_antal)
                : null,
              X.antalFirmaer(p.antal_firmaer),
            ].filter(Boolean);
            return (
              <li key={p.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-tekst">
                    {p.navn}
                    {p.arkiveret ? (
                      <span className="bg-admin-graa px-2.5 py-0.5 text-xs font-medium text-tekst-daempet">{P.arkiveret}</span>
                    ) : (
                      !p.aktiv && <span className="bg-admin-graa px-2.5 py-0.5 text-xs font-medium text-tekst-daempet">{X.skjult}</span>
                    )}
                  </p>
                  <p className="text-sm text-tekst-daempet">{dele.join(" · ")}</p>
                  {p.arkiveret && <p className="text-sm text-tekst-svag">{P.arkiveretHjaelp}</p>}
                  {p.beskrivelse && <p className="mt-1 text-sm text-tekst-daempet">{p.beskrivelse}</p>}
                </div>
                {erChef && !p.arkiveret && (
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
            );
          })}
        </ul>
      )}

      {erChef && !kladde && (
        <button type="button" onClick={() => setKladde(NY)} className="btn btn-primaer">
          {A.pakker.knapNy}
        </button>
      )}

      {erChef && kladde && (
        <form
          method="post"
          onSubmit={(e) => {
            e.preventDefault();
            gem(kladde, false);
          }}
          noValidate
          className="space-y-4 border border-kant bg-white p-5"
        >
          <h3 className="text-base font-semibold text-tekst">{kladde.id ? `${X.knapRet}: ${kladde.navn}` : A.pakker.knapNy}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="pakke-navn" className={ADMIN_LABEL}>
                {A.pakker.feltNavn}
              </label>
              <input
                id="pakke-navn"
                value={kladde.navn}
                maxLength={G.pakkeNavn}
                placeholder={A.pakker.feltNavnPladsholder}
                onChange={(e) => setKladde({ ...kladde, navn: e.target.value })}
                className={ADMIN_FELT}
              />
            </div>
            <div>
              <label htmlFor="pakke-pris" className={ADMIN_LABEL}>
                {A.pakker.feltPris}
              </label>
              <input
                id="pakke-pris"
                inputMode="numeric"
                value={kladde.pris}
                aria-describedby="pakke-pris-hjaelp"
                aria-invalid={/[.,]/.test(kladde.pris) || undefined}
                onChange={(e) => setKladde({ ...kladde, pris: e.target.value.replace(/[^\d.,\s]/g, "").slice(0, 10) })}
                className={ADMIN_FELT}
              />
              <Hjaelp id="pakke-pris-hjaelp">{X.prisTomHjaelp}</Hjaelp>
            </div>

            <div className="sm:col-span-2">
              <Afkryds
                checked={kladde.ubegraenset}
                onChange={(v) => setKladde({ ...kladde, ubegraenset: v })}
                titel={P.ubegraenset}
                hjaelp={P.ubegraensetHjaelp}
              />
            </div>
            {!kladde.ubegraenset && (
              <div>
                <label htmlFor="pakke-antal" className={ADMIN_LABEL}>
                  {A.pakker.feltAuktioner}
                </label>
                <input
                  id="pakke-antal"
                  inputMode="numeric"
                  value={kladde.auktioner}
                  aria-describedby="pakke-antal-hjaelp"
                  onChange={(e) => setKladde({ ...kladde, auktioner: tal(e.target.value) })}
                  className={ADMIN_FELT}
                />
                <Hjaelp id="pakke-antal-hjaelp">{P.antalHjaelp}</Hjaelp>
              </div>
            )}
            <div>
              <label htmlFor="pakke-fremh" className={ADMIN_LABEL}>
                {P.fremh}
              </label>
              <input
                id="pakke-fremh"
                inputMode="numeric"
                value={kladde.fremh}
                aria-describedby="pakke-fremh-hjaelp"
                onChange={(e) => setKladde({ ...kladde, fremh: tal(e.target.value, 4) })}
                className={ADMIN_FELT}
              />
              <Hjaelp id="pakke-fremh-hjaelp">{P.fremhHjaelp}</Hjaelp>
            </div>
            <div>
              <label htmlFor="pakke-statistik" className={ADMIN_LABEL}>
                {P.statistik}
              </label>
              <select
                id="pakke-statistik"
                value={kladde.statistik}
                onChange={(e) => setKladde({ ...kladde, statistik: e.target.value as Statistik })}
                className={ADMIN_FELT}
              >
                {(["ingen", "statistik", "fuld"] as const).map((s) => (
                  <option key={s} value={s}>
                    {P.statistikValg[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <Afkryds
                checked={kladde.fastKontakt}
                onChange={(v) => setKladde({ ...kladde, fastKontakt: v })}
                titel={P.fastKontakt}
                hjaelp={P.fastKontaktHjaelp}
              />
            </div>

            <fieldset className="border border-kant p-4 sm:col-span-2">
              <legend className="px-1 text-sm font-semibold text-tekst">{P.ugensTitel}</legend>
              <p className="text-[13px] text-tekst-daempet">{P.ugensHjaelp}</p>
              <div className="mt-3 grid grid-cols-1 gap-4 min-[420px]:grid-cols-2">
                <div>
                  <label htmlFor="pakke-ugens-pct" className={ADMIN_LABEL}>
                    {P.ugensProcent}
                  </label>
                  <input
                    id="pakke-ugens-pct"
                    inputMode="numeric"
                    value={kladde.ugensProcent}
                    onChange={(e) => setKladde({ ...kladde, ugensProcent: tal(e.target.value, 2) })}
                    className={ADMIN_FELT}
                  />
                </div>
                <div>
                  <label htmlFor="pakke-ugens-antal" className={ADMIN_LABEL}>
                    {P.ugensAntal}
                  </label>
                  <input
                    id="pakke-ugens-antal"
                    inputMode="numeric"
                    value={kladde.ugensAntal}
                    onChange={(e) => setKladde({ ...kladde, ugensAntal: tal(e.target.value, 2) })}
                    className={ADMIN_FELT}
                  />
                </div>
              </div>
            </fieldset>

            <div>
              <label htmlFor="pakke-sortering" className={ADMIN_LABEL}>
                {X.feltSortering}
              </label>
              <input
                id="pakke-sortering"
                inputMode="numeric"
                value={kladde.sortering}
                aria-describedby="pakke-sortering-hjaelp"
                onChange={(e) => setKladde({ ...kladde, sortering: e.target.value.replace(/[^\d-]/g, "").slice(0, 5) })}
                className={ADMIN_FELT}
              />
              <Hjaelp id="pakke-sortering-hjaelp">{X.feltSorteringHjaelp}</Hjaelp>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="pakke-beskrivelse" className={ADMIN_LABEL}>
                {X.feltBeskrivelse}
              </label>
              <textarea
                id="pakke-beskrivelse"
                rows={3}
                value={kladde.beskrivelse}
                maxLength={G.pakkeBeskrivelse}
                onChange={(e) => setKladde({ ...kladde, beskrivelse: e.target.value })}
                className="min-h-[90px] w-full border border-kant-staerk bg-white px-4 py-3 text-[15px] focus:border-groen focus:outline-2 focus:outline-groen/25"
              />
            </div>
          </div>
          <Afkryds
            checked={kladde.aktiv}
            onChange={(v) => setKladde({ ...kladde, aktiv: v })}
            titel={A.pakker.feltAktiv}
            hjaelp={A.pakker.feltAktivHjaelp}
          />

          {fejl && (
            <p role="alert" className="border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
              {fejl}
            </p>
          )}

          {advarsel !== null ? (
            <div role="alertdialog" aria-labelledby="pakke-advarsel" className="border border-advarsel-kant bg-advarsel-bg p-4 text-advarsel-tekst">
              <p id="pakke-advarsel" className="font-semibold">
                {X.pakkeBrugesTitel}
              </p>
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
              <button type="submit" disabled={gemmer || !hydreret} aria-busy={gemmer || undefined} className="btn btn-primaer">
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
