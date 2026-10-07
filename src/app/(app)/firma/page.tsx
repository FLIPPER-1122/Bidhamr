import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentBruger } from "@/lib/supabase/bruger";
import { hentFirmaOversigt } from "@/app/actions/erhverv";
import PakkeValg, { PakkeInfo } from "@/components/erhverv/PakkeValg";
import {
  E_KNAP_PRIMAER,
  E_KNAP_SEKUNDAER,
  E_KORT,
  E_KORT_TITEL,
  E_TEKST,
  E_TEKST_DAEMPET,
} from "@/components/erhverv/stil";
import { FIRMA_OVERSIGT as T, FIRMA_OVERSIGT_EKSTRA as X } from "@/lib/tekster/erhverv";
import { ERHVERV_EMAIL } from "@/lib/erhverv/regler";
import { kr, krFraOere, langDato, naesteLedigeTekst, ugedagDato } from "@/lib/erhverv/visning";

// Firma oversigt (dashboard) - kun for firmakonti; alle andre sendes væk.
// Profilmenuen viser kun denne side for en firmakonto, så ALT firmaet skal
// bruge (opret auktion, handler, beskeder, abonnement) kan nås herfra.
// Data: firma_oversigt (samme RPC som appen) via hentFirmaOversigt.
// Målgruppen er primært ældre: stor tekst, store knapper, få valg pr. kort.

export const metadata: Metadata = { title: T.titel, robots: { index: false, follow: false } };

function Kort({ id, titel, forklaring, children }: { id: string; titel: string; forklaring?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className={E_KORT}>
      <h2 id={id} className={E_KORT_TITEL}>
        {titel}
      </h2>
      {forklaring && <p className={`mt-1 ${E_TEKST_DAEMPET}`}>{forklaring}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Tal({ label, vaerdi }: { label: string; vaerdi: string }) {
  return (
    <div className="rounded-[14px] bg-groen-lys p-4">
      <p className="text-[16px] text-groen-mork">{label}</p>
      <p className="mt-1 text-[28px] leading-tight font-bold text-tekst tabular-nums">{vaerdi}</p>
    </div>
  );
}

export default async function FirmaOversigtSide() {
  const bruger = await hentBruger();
  if (!bruger) redirect("/login?redirect=/firma");

  const supabase = await createClient();
  const [svar, { data: aktiveRaw }] = await Promise.all([
    hentFirmaOversigt(),
    // Kun de kolonner, listen bruger, og højst 10 (alle ses på profilen).
    supabase
      .from("auctions")
      .select("id, titel, slutter_kl, antal_bud")
      .eq("bruger_id", bruger.id)
      .eq("status", "aktiv")
      .order("slutter_kl", { ascending: true })
      .limit(10),
  ]);
  if ("fejl" in svar) throw new Error(T.fejlHent);
  const o = svar.oversigt;
  // Ikke en firmakonto.
  if (!o) redirect("/");

  const aktive = (aktiveRaw ?? []) as { id: string; titel: string; slutter_kl: string; antal_bud: number | null }[];
  const f = o.firma;
  const k = o.ugekvote;
  const abonnementAktivt = f.abonnement_status === "aktiv" && !!k?.aktivt_abonnement;
  const kvoteBrugt = !!k && k.brugt >= k.max;
  const kanOprette = abonnementAktivt && !kvoteBrugt;
  const opretForklaring = !abonnementAktivt
    ? f.abonnement_status === "pauset"
      ? X.pakkePause
      : f.abonnement_status === "opsagt"
        ? X.pakkeOpsagt
        : X.kanIkkeOpretteIkkeAktiv
    : kvoteBrugt && k
      ? T.auktioner.alleBrugt(naesteLedigeTekst(k))
      : null;

  const venter = o.venter_paa_dig;
  const spoergsmaal = o.ubesvarede_spoergsmaal;
  const andrePakker = o.pakker.filter((p) => p.id !== o.pakke?.id);
  const naestePeriode = langDato(f.betalt_til ?? f.naeste_periode);

  return (
    <main className="flex-1 bg-[#F6F9F8] px-4 py-8 sm:px-6 lg:py-12">
      <div className="mx-auto max-w-[860px] space-y-6">
        <div>
          <p className="text-[17px] font-semibold text-groen-mork">{f.firmanavn}</p>
          <h1 className="mt-1 text-[32px] leading-tight sm:text-[40px]">{T.titel}</h1>
          <p className={`mt-2 ${E_TEKST_DAEMPET}`}>{T.intro}</p>
        </div>

        {!abonnementAktivt && (
          <div role="status" className="rounded-[18px] border-2 border-advarsel-kant bg-advarsel-bg p-5 text-advarsel-tekst">
            <p className="text-[20px] font-semibold">{T.ikkeAktiv.titel}</p>
            <p className="mt-1 text-[18px]">
              {f.abonnement_status === "pauset" ? X.pakkePause : f.abonnement_status === "opsagt" ? X.pakkeOpsagt : T.ikkeAktiv.tekst}
            </p>
          </div>
        )}

        {/* Genveje: det, firmaet bruger mest. Ingen skjulte menuer. */}
        <nav aria-label={X.genvejeTitel} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            { href: "/mine-handler", titel: X.genveje.handler, tekst: X.genveje.handlerTekst },
            { href: "/beskeder", titel: X.genveje.beskeder, tekst: X.genveje.beskederTekst },
            { href: `/profil/${bruger.id}`, titel: X.genveje.auktioner, tekst: X.genveje.auktionerTekst },
          ].map((g) => (
            <Link
              key={g.href}
              href={g.href}
              className="flex min-h-[96px] flex-col justify-center rounded-[14px] border-2 border-groen bg-white p-4 hover:bg-groen-lys focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              <span className="text-[20px] font-semibold text-groen-mork">{g.titel} →</span>
              <span className="mt-1 text-[16px] text-tekst-daempet">{g.tekst}</span>
            </Link>
          ))}
        </nav>

        {/* 1. Overblik */}
        <Kort id="overblik" titel={T.overblik.titel} forklaring={T.overblik.forklaring}>
          {o.salg.solgte_i_alt === 0 ? (
            <p className={E_TEKST}>{T.overblik.tom}</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Tal label={T.overblik.denneMaaned} vaerdi={kr(o.salg.omsaetning_denne_maaned)} />
                <Tal label={T.overblik.iAlt} vaerdi={kr(o.salg.omsaetning_i_alt)} />
                <Tal label={T.overblik.udbetalt} vaerdi={krFraOere(o.udbetalinger.udbetalt_i_alt_oere)} />
                <Tal label={T.overblik.paaVej} vaerdi={krFraOere(o.udbetalinger.paa_vej_oere)} />
              </div>
              <p className={`mt-4 ${E_TEKST_DAEMPET}`}>{T.overblik.paaVejHjaelp}</p>
            </>
          )}
        </Kort>

        {/* 2. Venter på dig */}
        <Kort id="venter" titel={T.venter.titel} forklaring={T.venter.forklaring}>
          {venter.length === 0 && spoergsmaal.length === 0 ? (
            <p className={E_TEKST}>{T.venter.tom}</p>
          ) : (
            <ul className="space-y-4">
              {venter.map((v) => {
                const vare = v.titel ?? "varen";
                return (
                  <li key={v.trade_id} className="rounded-[14px] border-2 border-orange bg-orange-lys p-4">
                    <p className={E_TEKST}>{v.afhentning ? X.afhentning(vare) : T.venter.sendPakke(vare)}</p>
                    <Link href={`/mine-handler/${v.trade_id}`} className={`${E_KNAP_PRIMAER} mt-3 w-full sm:w-auto`}>
                      {v.afhentning ? X.knapSeHandel : T.venter.knapSendPakke}
                    </Link>
                  </li>
                );
              })}
              {spoergsmaal.map((q) => (
                <li key={q.id} className="rounded-[14px] border-2 border-kant bg-white p-4">
                  <p className={E_TEKST}>{T.venter.svarSpoergsmaal(q.titel)}</p>
                  <p className={`mt-1 break-words italic ${E_TEKST_DAEMPET}`}>“{q.spoergsmaal}”</p>
                  <Link href={`/auktion/${q.auktion_id}#spoergsmaal`} className={`${E_KNAP_PRIMAER} mt-3 w-full sm:w-auto`}>
                    {T.venter.knapSvar}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Kort>

        {/* 3. Dine auktioner */}
        <Kort id="auktioner" titel={T.auktioner.titel} forklaring={T.auktioner.forklaring}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Tal label={T.auktioner.aktive(o.auktioner.aktive)} vaerdi={String(o.auktioner.aktive)} />
            {k && <Tal label={X.ugensTalLabel} vaerdi={X.ugensTal(k.brugt, k.max)} />}
          </div>
          {k && (
            <p className={`mt-4 ${E_TEKST}`}>
              {/* Er ugens auktioner brugt, står forklaringen ved knappen herunder. */}
              {T.auktioner.ledigeNu(k.brugt, k.max)}
            </p>
          )}

          <div className="mt-5">
            {kanOprette ? (
              <Link href="/opret-auktion" className={`${E_KNAP_PRIMAER} w-full sm:w-auto`}>
                {T.auktioner.knapOpret}
              </Link>
            ) : (
              <>
                <button type="button" disabled aria-describedby="opret-forklaring" className={`${E_KNAP_PRIMAER} w-full sm:w-auto`}>
                  {T.auktioner.knapOpret}
                </button>
                {opretForklaring && (
                  <p id="opret-forklaring" className="mt-3 rounded-lg bg-advarsel-bg px-4 py-3 text-[17px] text-advarsel-tekst">
                    {opretForklaring}
                  </p>
                )}
              </>
            )}
          </div>

          {aktive.length === 0 ? (
            <p className={`mt-5 ${E_TEKST_DAEMPET}`}>{T.auktioner.tom}</p>
          ) : (
            <ul className="mt-5 divide-y divide-kant rounded-[14px] border border-kant">
              {aktive.map((a) => (
                <li key={a.id}>
                  <Link
                    href={`/auktion/${a.id}`}
                    className="flex min-h-14 flex-col gap-1 px-4 py-3 hover:bg-groen-lys focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-groen sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="text-[18px] font-semibold break-words text-groen-mork underline underline-offset-2">{a.titel}</span>
                    <span className="shrink-0 text-[16px] text-tekst-daempet">
                      {X.bud(a.antal_bud ?? 0)} · {X.slutter} {ugedagDato(a.slutter_kl)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link
            href={`/profil/${bruger.id}`}
            className="mt-4 inline-flex min-h-12 items-center text-[18px] font-semibold text-groen underline underline-offset-2"
          >
            {T.auktioner.knapSeAlle} →
          </Link>
        </Kort>

        {/* 4. Visninger og salg */}
        <Kort id="visninger" titel={`${T.visninger.titel} og ${T.salg.titel.toLowerCase()}`} forklaring={T.visninger.forklaring}>
          {o.auktioner.i_alt === 0 ? (
            <p className={E_TEKST}>{T.visninger.tom}</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Tal label={T.visninger.iAlt} vaerdi={o.auktioner.visninger.toLocaleString("da-DK")} />
              <Tal label={X.visningerAktive} vaerdi={o.auktioner.visninger_aktive.toLocaleString("da-DK")} />
              <Tal label={T.visninger.bud} vaerdi={o.auktioner.bud.toLocaleString("da-DK")} />
              <Tal label={X.solgtDenneMaaned} vaerdi={o.salg.solgte_denne_maaned.toLocaleString("da-DK")} />
              <Tal label={X.solgtIAlt} vaerdi={o.salg.solgte_i_alt.toLocaleString("da-DK")} />
            </div>
          )}
          <Link href="/mine-handler" className={`${E_KNAP_SEKUNDAER} mt-5 w-full sm:w-auto`}>
            {X.seSalg}
          </Link>
        </Kort>

        {/* 5. Abonnement */}
        <Kort id="abonnement" titel={T.abonnement.titel} forklaring={T.abonnement.forklaring}>
          {o.pakke ? (
            <div className="rounded-[14px] border-2 border-groen bg-groen-lys p-5">
              <p className="text-[16px] font-semibold text-groen-mork">{T.abonnement.dinPakke}</p>
              <div className="mt-1">
                <PakkeInfo pakke={o.pakke} />
              </div>
            </div>
          ) : (
            <p className={E_TEKST}>{X.ingenPakke}</p>
          )}

          {o.afventende_opgradering && (
            <div role="status" className="mt-4 rounded-[14px] border-2 border-advarsel-kant bg-advarsel-bg p-4 text-advarsel-tekst">
              <p className="text-[19px] font-semibold">{X.afventerTitel}</p>
              <p className="mt-1 text-[18px]">{X.afventerTekst(o.afventende_opgradering.navn)}</p>
            </div>
          )}
          {o.naeste_pakke && (
            <p role="status" className="mt-4 rounded-[14px] bg-info-bg p-4 text-[18px] text-info-tekst">
              {T.abonnement.planlagtSkift(o.naeste_pakke.navn, langDato(o.naeste_pakke.fra))}
            </p>
          )}

          {o.pakke && andrePakker.length > 0 && (
            <div className="mt-6">
              <PakkeValg
                nuvaerende={o.pakke}
                andre={andrePakker}
                naestePeriode={naestePeriode}
                kanSkifte={f.abonnement_status === "aktiv"}
                afventerId={o.afventende_opgradering?.id ?? null}
              />
              {f.abonnement_status !== "aktiv" && (
                <p className={`mt-4 ${E_TEKST_DAEMPET}`}>{T.abonnement.betalingIkkeSatOpSkift}</p>
              )}
            </div>
          )}
        </Kort>

        {/* 6. Regninger */}
        <Kort id="regninger" titel={T.regninger.titel} forklaring={T.regninger.forklaring}>
          {o.regninger.length === 0 ? (
            <p className={E_TEKST}>{T.regninger.tom}</p>
          ) : (
            <ul className="divide-y divide-kant rounded-[14px] border border-kant">
              {o.regninger.map((r) => (
                <li key={r.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-[18px] font-semibold text-tekst">
                      {X.regningType[r.type]} · {krFraOere(r.beloeb_oere)}
                    </p>
                    <p className={E_TEKST_DAEMPET}>
                      {T.regninger.kolonneDato}: {langDato(r.oprettet)} · {X.regningStatus[r.status]}
                    </p>
                  </div>
                  {r.pdf_url && (
                    <a href={r.pdf_url} target="_blank" rel="noopener noreferrer" className={E_KNAP_SEKUNDAER}>
                      {T.regninger.knapHent}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Kort>

        {/* 7. Firmaoplysninger (kun læse) */}
        <Kort id="firmaoplysninger" titel={T.firmaoplysninger.titel} forklaring={T.firmaoplysninger.forklaring}>
          <dl className="space-y-4">
            {(
              [
                [T.firmaoplysninger.firmanavn, f.firmanavn],
                [T.firmaoplysninger.cvr, f.cvr],
                [T.firmaoplysninger.adresse, `${f.adresse}, ${f.postnummer} ${f.by}`],
                [T.firmaoplysninger.kontaktperson, f.kontaktperson],
                [T.firmaoplysninger.telefon, f.telefon],
                [T.firmaoplysninger.email, f.kontakt_email],
              ] as const
            ).map(([label, vaerdi]) => (
              <div key={label}>
                <dt className="text-[16px] text-tekst-daempet">{label}</dt>
                <dd className={`${E_TEKST} break-words`}>{vaerdi}</dd>
              </div>
            ))}
          </dl>
          <p className={`mt-5 ${E_TEKST}`}>
            {T.firmaoplysninger.rettes}{" "}
            <a href={`mailto:${ERHVERV_EMAIL}`} className="font-semibold text-groen underline underline-offset-2">
              {ERHVERV_EMAIL}
            </a>
          </p>
        </Kort>

        {/* 8. Kontakt BidHamr */}
        <Kort id="kontakt" titel={T.kontakt.titel}>
          <p className={E_TEKST}>{T.kontakt.tekst}</p>
          <p className="mt-2 text-[20px] font-semibold break-all text-tekst">{o.kontakt_bidhamr || T.kontakt.email}</p>
          <a href={`mailto:${o.kontakt_bidhamr || T.kontakt.email}`} className={`${E_KNAP_PRIMAER} mt-4 w-full sm:w-auto`}>
            {T.kontakt.knap}
          </a>
        </Kort>
      </div>
    </main>
  );
}
