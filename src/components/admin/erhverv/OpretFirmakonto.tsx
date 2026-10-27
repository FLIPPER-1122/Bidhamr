"use client";

// Opret firmakonto fra en godkendt henvendelse: CVR-opslag (slaaCvrOp) der
// udfylder navn og adresse (ellers tastes de selv), pakke og firmaets e-mail,
// bekræftelse -> opretFirmakonto. Resultatet vises tydeligt bagefter.
import Link from "next/link";
import { useState, useTransition } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import FirmaFelter, { ADMIN_FELT, ADMIN_LABEL, type FirmaVaerdier } from "@/components/admin/erhverv/FirmaFelter";
import { opretFirmakonto, slaaCvrOp, type CvrTidligereFirma } from "@/app/actions/adminErhverv";
import { ADMIN_ERHVERV as A, ADMIN_ERHVERV_EKSTRA as X, FIRMA_PAKKER } from "@/lib/tekster/erhverv";
import { ABONNEMENT_STATUS_NAVN, EMAIL, POSTNUMMER, erAbonnementStatus, type ErhvervPakke } from "@/lib/erhverv/regler";
import { langDato } from "@/lib/erhverv/visning";
import { INTRO_GRAENSER, INTRO_STANDARD } from "@/lib/erhverv/abonnementRegler";

export default function OpretFirmakonto({
  henvendelseId,
  start,
  loginEmail: startLogin,
  pakker,
  firmaId = null,
  godkendt = true,
}: {
  henvendelseId: string;
  // Henvendelsen har allerede fået en firmakonto / er ikke godkendt. Siden
  // renderer ALTID denne komponent på samme plads (også i de to tilfælde),
  // så React beholder resultatet, når revalidatePath i opretFirmakonto
  // henter siden igen med firma_id sat - ellers forsvandt kvitteringen.
  firmaId?: string | null;
  godkendt?: boolean;
  start: FirmaVaerdier;
  loginEmail: string;
  pakker: ErhvervPakke[];
}) {
  const [v, setV] = useState<FirmaVaerdier>(start);
  const [loginEmail, setLoginEmail] = useState(startLogin);
  const [pakkeId, setPakkeId] = useState(pakker.length === 1 ? pakker[0].id : "");
  // Introrabat efter den gratis måned: kun til firmaer, Filip selv har rakt
  // ud til (ROADMAP-BESLUTNINGER) - derfor slået FRA som standard. Slås den
  // til, er 50 % i 6 måneder udfyldt.
  const [medIntro, setMedIntro] = useState(false);
  const [introProcent, setIntroProcent] = useState(String(INTRO_STANDARD.procent));
  const [introMaaneder, setIntroMaaneder] = useState(String(INTRO_STANDARD.maaneder));
  const [cvrBesked, setCvrBesked] = useState<{ tekst: string; ok: boolean } | null>(null);
  const [slaarOp, startOpslag] = useTransition();
  const [feltFejl, setFeltFejl] = useState<Partial<Record<keyof FirmaVaerdier, string>>>({});
  const [resultat, setResultat] = useState<{ firmaId: string; besked: string; mailSendt: boolean } | null>(null);
  // CVR'et har haft et abonnement før: advarslen vises i dialogen, og næste
  // tryk ("Opret alligevel") sender bekræftelsen med.
  const [tidligere, setTidligere] = useState<CvrTidligereFirma[] | null>(null);

  // Rettes CVR-nummeret, passer en gammel besked fra CVR-opslaget ikke
  // længere (fx "ikke fundet") - så fjernes den.
  // Tjekkes, før bekræftelsen åbnes (serveren tjekker igen). Feltet markeres.
  // TODO indhold-agenten: fejlteksten.
  function tjekFelter(): boolean {
    const f: Partial<Record<keyof FirmaVaerdier, string>> = {};
    if (!POSTNUMMER.test(v.postnummer.trim())) f.postnummer = "Postnummeret skal være 4 cifre fra 1000 til 9999.";
    setFeltFejl(f);
    if (f.postnummer) {
      document.getElementById("opret-postnummer")?.focus();
      return false;
    }
    return true;
  }

  function saetV(ny: FirmaVaerdier) {
    if (ny.postnummer !== v.postnummer && feltFejl.postnummer) setFeltFejl((g) => ({ ...g, postnummer: undefined }));
    if (ny.cvr !== v.cvr) setCvrBesked(null);
    setV(ny);
  }

  function cvrOpslag() {
    setCvrBesked(null);
    startOpslag(async () => {
      const svar = await slaaCvrOp(v.cvr);
      if (!("firma" in svar) || !svar.ok) {
        setCvrBesked({ tekst: "fejl" in svar && svar.fejl ? svar.fejl : A.opret.fejl.cvrOpslagFejl, ok: false });
        return;
      }
      const f = svar.firma;
      if (!f.aktiv) {
        setCvrBesked({ tekst: A.opret.fejl.cvrIkkeAktivt, ok: false });
        return;
      }
      setV((gl) => ({
        ...gl,
        cvr: f.cvr,
        firmanavn: f.firmanavn || gl.firmanavn,
        adresse: f.adresse ?? gl.adresse,
        postnummer: f.postnummer ?? gl.postnummer,
        by: f.by ?? gl.by,
      }));
      setCvrBesked({ tekst: X.cvrFundet, ok: true });
    });
  }

  if (resultat) {
    return (
      <div
        role="status"
        className={`rounded-xl border p-5 ${resultat.mailSendt ? "border-succes-kant bg-succes-bg text-succes-tekst" : "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst"}`}
      >
        <p className="text-base font-semibold">{resultat.besked}</p>
        <Link href={`/admin/erhverv/firmaer/${resultat.firmaId}`} className="btn btn-sekundaer mt-4">
          {X.seFirma}
        </Link>
      </div>
    );
  }

  if (firmaId) {
    return (
      <div className="rounded-xl border border-succes-kant bg-succes-bg p-4 text-succes-tekst">
        <p className="font-semibold">{X.firmaOprettet}</p>
        <Link href={`/admin/erhverv/firmaer/${firmaId}`} className="btn btn-sekundaer mt-3">
          {X.seFirma}
        </Link>
      </div>
    );
  }

  if (!godkendt) {
    return (
      <p className="rounded-lg border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
        {A.opret.fejl.ikkeGodkendt}
      </p>
    );
  }

  const ip = Number(introProcent);
  const im = Number(introMaaneder);
  const introGyldig =
    !medIntro ||
    (/^\d+$/.test(introProcent) &&
      /^\d+$/.test(introMaaneder) &&
      ip >= INTRO_GRAENSER.procentMin &&
      ip <= INTRO_GRAENSER.procentMaks &&
      im >= INTRO_GRAENSER.maanederMin &&
      im <= INTRO_GRAENSER.maanederMaks);
  const klar = !!pakkeId && EMAIL.test(loginEmail.trim()) && introGyldig;
  const valgtPakke = pakker.find((p) => p.id === pakkeId) ?? null;
  const opsummering = valgtPakke
    ? A.opret.pakkeOpsummering(
        valgtPakke.navn,
        valgtPakke.maanedspris != null ? krTekst(valgtPakke.maanedspris) : null,
        medIntro && introGyldig
          ? {
              procent: ip,
              maaneder: im,
              pris: valgtPakke.maanedspris != null ? krTekst((valgtPakke.maanedspris * (100 - ip)) / 100) : null,
            }
          : null,
      )
    : medIntro
      ? A.opret.introOpsummering(ip, im)
      : A.opret.udenIntro;

  return (
    <div className="space-y-5">
      <p className="text-sm text-neutral-600">{A.opret.forklaring}</p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <label htmlFor="opret-cvr-opslag" className={ADMIN_LABEL}>
            {X.felter.cvr}
          </label>
          <input
            id="opret-cvr-opslag"
            inputMode="numeric"
            value={v.cvr}
            onChange={(e) => saetV({ ...v, cvr: e.target.value })}
            className={ADMIN_FELT}
          />
        </div>
        <button type="button" onClick={cvrOpslag} disabled={slaarOp} aria-busy={slaarOp || undefined} className="btn btn-sekundaer">
          {slaarOp && <span className="btn-spinner" aria-hidden="true" />}
          {X.knapSlaaCvrOp}
        </button>
      </div>
      {cvrBesked && (
        <p
          role={cvrBesked.ok ? "status" : "alert"}
          className={`rounded-lg border px-4 py-3 text-sm ${cvrBesked.ok ? "border-succes-kant bg-succes-bg text-succes-tekst" : "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst"}`}
        >
          {cvrBesked.tekst}
        </p>
      )}

      <FirmaFelter vaerdier={v} onChange={saetV} idPraefiks="opret" fejl={feltFejl} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="opret-login" className={ADMIN_LABEL}>
            {A.opret.feltEmail}
          </label>
          <input
            id="opret-login"
            type="email"
            inputMode="email"
            value={loginEmail}
            onChange={(e) => setLoginEmail(e.target.value)}
            className={ADMIN_FELT}
          />
        </div>
        <div>
          <label htmlFor="opret-pakke" className={ADMIN_LABEL}>
            {A.opret.feltPakke}
          </label>
          <select id="opret-pakke" value={pakkeId} onChange={(e) => setPakkeId(e.target.value)} className={ADMIN_FELT} aria-describedby="opret-pakke-hjaelp">
            <option value="">{A.opret.fejl.ingenPakke}</option>
            {pakker
              .filter((p) => !p.arkiveret)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {A.opret.pakkeValg(
                    p.navn,
                    FIRMA_PAKKER.auktionerPrMaaned(p.ubegraenset ? null : p.auktioner_pr_maaned).toLowerCase(),
                    p.maanedspris != null ? `${p.maanedspris.toLocaleString("da-DK")} kr.` : null,
                  )}
                </option>
              ))}
          </select>
          <p id="opret-pakke-hjaelp" className="mt-1.5 text-[13px] text-tekst-daempet">
            {A.opret.feltPakkeHjaelp}
          </p>
        </div>
      </div>

      <fieldset className="border border-kant p-4">
        <legend className="px-1 text-sm font-semibold text-tekst">{A.opret.introTitel}</legend>
        <label className="flex min-h-11 cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={medIntro}
            onChange={(e) => setMedIntro(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 accent-groen"
          />
          <span>
            <span className="block text-[15px] font-medium text-tekst">{A.opret.introSlaa}</span>
            <span className="block text-[13px] text-tekst-daempet">{A.opret.introHjaelp}</span>
          </span>
        </label>
        {medIntro && (
          <div className="mt-3 grid grid-cols-1 gap-4 min-[420px]:grid-cols-2">
            <div>
              <label htmlFor="opret-intro-procent" className={ADMIN_LABEL}>
                {A.opret.introProcent}
              </label>
              <input
                id="opret-intro-procent"
                inputMode="numeric"
                value={introProcent}
                aria-invalid={!introGyldig || undefined}
                onChange={(e) => setIntroProcent(e.target.value.replace(/\D/g, "").slice(0, 3))}
                className={ADMIN_FELT}
              />
            </div>
            <div>
              <label htmlFor="opret-intro-maaneder" className={ADMIN_LABEL}>
                {A.opret.introMaaneder}
              </label>
              <input
                id="opret-intro-maaneder"
                inputMode="numeric"
                value={introMaaneder}
                aria-invalid={!introGyldig || undefined}
                onChange={(e) => setIntroMaaneder(e.target.value.replace(/\D/g, "").slice(0, 2))}
                className={ADMIN_FELT}
              />
            </div>
          </div>
        )}
        <p className={`mt-3 text-[13px] ${introGyldig ? "text-tekst-daempet" : "font-medium text-fejl-tekst"}`} role={introGyldig ? undefined : "alert"}>
          {!introGyldig ? A.opret.introUgyldig : opsummering}
        </p>
      </fieldset>

      <BekraeftDialog
        triggerLabel={A.opret.knapOpret}
        triggerClassName="btn btn-primaer btn-stor w-full sm:w-auto disabled:opacity-50"
        title={X.bekraeftOpretTitel}
        description={`${opsummering} ${X.bekraeftOpret(loginEmail.trim())}`}
        confirmLabel={tidligere ? X.cvrTidligere.knap : A.opret.knapOpret}
        confirmDisabled={!klar}
        foerAabning={() => {
          // Ny åbning = nyt tjek (felterne kan være rettet siden).
          setTidligere(null);
          return tjekFelter();
        }}
        onConfirm={async () => {
          if (!pakkeId) return { fejl: A.opret.fejl.ingenPakke };
          const svar = await opretFirmakonto({
            ...v,
            loginEmail,
            pakkeId,
            henvendelseId,
            introProcent: medIntro ? ip : null,
            introMaaneder: medIntro ? im : null,
            cvrBekraeftet: tidligere !== null,
          });
          if ("fejl" in svar) return { fejl: svar.fejl };
          if ("cvrTidligere" in svar) {
            setTidligere(svar.firmaer ?? []);
            return { bliv: true };
          }
          // Resultatet ligger i state; siden genindlæses (revalidatePath),
          // men komponenten står samme sted og beholder det.
          setResultat({ firmaId: svar.firmaId, besked: svar.besked, mailSendt: svar.mailSendt });
        }}
      >
        {tidligere && <CvrTidligere firmaer={tidligere} />}
      </BekraeftDialog>
    </div>
  );
}

// 999 -> "999 kr.", 499.5 -> "499,50 kr."
function krTekst(beloeb: number): string {
  const heltal = Number.isInteger(beloeb);
  return `${beloeb.toLocaleString("da-DK", {
    minimumFractionDigits: heltal ? 0 : 2,
    maximumFractionDigits: heltal ? 0 : 2,
  })} kr.`;
}

function CvrTidligere({ firmaer }: { firmaer: CvrTidligereFirma[] }) {
  const C = X.cvrTidligere;
  const dato = (iso: string | null) => (iso ? langDato(iso) : C.ingenDato);
  return (
    <div role="alert" className="border border-advarsel-kant bg-advarsel-bg p-3 text-sm text-advarsel-tekst">
      <p className="font-bold">{C.titel}</p>
      <p className="mt-1">{C.tekst}</p>
      <ul className="mt-3 space-y-2">
        {firmaer.map((f, i) => (
          <li key={i} className="border border-advarsel-kant bg-white p-2.5 text-tekst">
            <p className="break-words font-semibold">{f.firmanavn || "–"}</p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
              <dt className="text-tekst-daempet">{C.status}</dt>
              <dd>{erAbonnementStatus(f.abonnement_status) ? ABONNEMENT_STATUS_NAVN[f.abonnement_status] : f.abonnement_status}</dd>
              <dt className="text-tekst-daempet">{C.start}</dt>
              <dd>{dato(f.abonnement_start)}</dd>
              <dt className="text-tekst-daempet">{C.opsagt}</dt>
              <dd>{dato(f.opsagt_kl)}</dd>
              <dt className="text-tekst-daempet">{C.gratis}</dt>
              <dd>{f.havde_gratis_periode ? C.ja : C.nej}</dd>
              <dt className="text-tekst-daempet">{C.regninger}</dt>
              <dd className="tabular-nums">{f.betalte_regninger}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
