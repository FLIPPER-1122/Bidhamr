import Link from "next/link";
import { notFound } from "next/navigation";
import { ugensButikVisesNu } from "@/lib/erhverv/ugensButikVisning";
import { kraevErhvervSide } from "@/lib/adminAuth";
import { hentErhvervPakker, hentFirmaer } from "@/app/actions/adminErhverv";
import { hentErhvervKlager } from "@/app/actions/adminErhvervKlager";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminFaner from "@/components/admin/AdminFaner";
import { dato, datoTid } from "@/components/admin/erhverv/ErhvervFaner";
import FirmaRedigering from "@/components/admin/erhverv/FirmaRedigering";
import FirmaAbonnementStripe from "@/components/admin/erhverv/FirmaAbonnementStripe";
import FirmaKontoSektion, { type FirmaKontoTilstand } from "@/components/admin/erhverv/FirmaKontoSektion";
import AdvarselForslagHandlinger from "@/components/admin/erhverv/AdvarselForslagHandlinger";
import {
  FaneLink,
  FirmaHurtighandlinger,
  FirmaKraeverHandling,
  FirmaStatuslinje,
  StatusLampe,
  type KraeverPunkt,
  type Lampe,
} from "@/components/admin/erhverv/firma/FirmaOverblik";
import {
  FaneKvoter,
  FaneRegninger,
  FaneSalg,
  FaneUgensButik,
  Felt,
  KlageListe,
  LogListe,
  Raekker,
  UgeHandlinger,
} from "@/components/admin/erhverv/firma/FirmaFaner";
import { EtKlikKnap, FirmaNote, GenaktiverKnap, type LedigUge } from "@/components/admin/erhverv/firma/FirmaHandlinger";
import { introTilstand, ugeNr } from "@/components/admin/erhverv/firma/stil";
import {
  hentFirmaAuktionerOgSalg,
  hentFirmaFremhaevninger,
  hentFirmaLog,
  hentFirmaRegninger,
  hentFirmaUgensButik,
} from "@/lib/admin/firmaSide";
import { ADMIN_ERHVERV as A, ADMIN_ERHVERV_BETALING as AB, ADMIN_ERHVERV_EKSTRA as X } from "@/lib/tekster/erhverv";
import { ADMIN_FIRMA as T } from "@/lib/tekster/adminFirma";
import { KLAGE_ADMIN } from "@/lib/tekster/erhvervKlager";
import { ABONNEMENT_STATUS_NAVN } from "@/lib/erhverv/regler";
import { KLAGE_FORSLAG_ANTAL, KLAGE_FORSLAG_MAANEDER } from "@/lib/erhverv/klager";
import { kr, krFraOere, visTelefon } from "@/lib/erhverv/visning";
import { firmaTitel } from "@/lib/admin/erhvervTitel";

// Browserfanen hedder det samme som overskriften.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: await firmaTitel((await params).id) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FANER = ["abonnement", "kvoter", "ugens-butik", "oplysninger", "salg", "regninger", "log"] as const;
type Fane = (typeof FANER)[number];

// Admin -> Erhverv -> Firmaer -> [firma]. Chef og sælger-rollen kan det samme
// her (Filip, 26. okt. 2026); kun pakkernes standardpriser og et firmas
// købsoplysninger (firma_faktura_salg) er kun for chefen - ingen af dem står
// på siden, kun linket til Pakker for chefen. Alle handlinger tjekker rollen
// igen i server actions og i databasen.
export default async function FirmaSide({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fane?: string }>;
}) {
  const { admin, userId, rolle } = await kraevErhvervSide();
  const [{ id }, { fane: raaFane }] = await Promise.all([params, searchParams]);
  if (!UUID.test(id)) notFound();
  const fane: Fane = (FANER as readonly string[]).includes(raaFane ?? "") ? (raaFane as Fane) : "abonnement";

  const [res, pakkerSvar] = await Promise.all([hentFirmaer(), hentErhvervPakker()]);
  if ("fejl" in res) throw new Error(res.fejl);
  const f = res.firmaer.find((x) => x.id === id);
  if (!f) notFound();

  // Det, toppen af siden altid bruger (status, kræver handling, hurtighandlinger).
  const [{ data: konto }, { data: lukningForslag }, ugensSvar, klagerSvar] = await Promise.all([
    admin
      .from("users")
      .select("suspenderet, suspenderet_til, suspenderet_aarsag, konto_lukket_kl")
      .eq("id", f.bruger_id)
      .maybeSingle<FirmaKontoTilstand>(),
    admin
      .from("konto_lukning_forslag")
      .select("id, advarsler_antal")
      .eq("bruger_id", f.bruger_id)
      .eq("status", "afventer")
      .maybeSingle<{ id: string; advarsler_antal: number }>(),
    hentFirmaUgensButik(admin, userId, f.id),
    hentErhvervKlager({ status: null, firma: f.id }),
  ]);
  const pakker = "fejl" in pakkerSvar ? [] : pakkerSvar.pakker;
  const ugens = "fejl" in ugensSvar ? null : ugensSvar;
  const klager = "fejl" in klagerSvar ? [] : klagerSvar.klager;
  const forslag = "fejl" in klagerSvar ? [] : klagerSvar.forslag.filter((x) => x.firma_id === f.id);
  const aabneKlager = "fejl" in klagerSvar ? 0 : klagerSvar.antal.aaben + klagerSvar.antal.under_behandling;

  // Kun den aktive fanes ekstra data.
  const [regninger, salg, log, fremhaevninger, visesNuBruger] = await Promise.all([
    fane === "regninger" ? hentFirmaRegninger(admin, f.id) : Promise.resolve(null),
    fane === "salg" ? hentFirmaAuktionerOgSalg(admin, f.bruger_id) : Promise.resolve(null),
    fane === "log" ? hentFirmaLog(admin, f.id, f.bruger_id) : Promise.resolve(null),
    fane === "kvoter" ? hentFirmaFremhaevninger(admin, f.id) : Promise.resolve(null),
    fane === "ugens-butik" ? ugensButikVisesNu() : Promise.resolve(null),
  ]);

  // --- Tilstand ---------------------------------------------------------------
  // eslint-disable-next-line react-hooks/purity -- serverkomponent: tidspunktet for denne visning
  const nu = Date.now();
  const lukket = !!konto?.konto_lukket_kl;
  const suspenderet =
    !!konto?.suspenderet && (konto.suspenderet_til === null || new Date(konto.suspenderet_til).getTime() > nu);
  const status = f.abonnement_status;
  const opsiges = !!f.opsiges_fra && status !== "opsagt";
  const lampe: Lampe =
    lukket || suspenderet || status === "opsagt"
      ? "roed"
      : status === "aktiv" && !opsiges && !f.betaling_mislykket_kl
        ? "groen"
        : "gul";
  const statusTekst = lukket ? T.status.lukket : suspenderet ? T.status.suspenderet : (ABONNEMENT_STATUS_NAVN[status] ?? status);
  // Pakkens standardpris og det, firmaet faktisk betaler (særpris eller pakkens pris).
  const pakkePris = f.pakke?.maanedspris ?? null;
  const pris = f.pris ?? pakkePris;
  const kvote = f.kvote ?? null;
  const intro = f.introrabat ?? null;
  // intro_status kan ikke bruges (står altid 'aktiv') - intro_til afgør det.
  const introNu = intro ? introTilstand(intro.til, nu) : null;
  const gratisTil = f.gratis_til && new Date(f.gratis_til).getTime() > nu ? f.gratis_til : null;
  const naesteDato = gratisTil ?? f.periode_slut ?? f.betalt_til;
  // Næste betaling med introrabat, hvis rabatten gælder den (planlagt, eller
  // kører stadig ved næste betaling).
  const introGaelder =
    !!intro &&
    introNu !== "slut" &&
    (!intro.til || !naesteDato || new Date(intro.til).getTime() > new Date(naesteDato).getTime());
  const naestePris = pris != null && introGaelder && intro ? (pris * (100 - intro.procent)) / 100 : pris;
  const kortTekst = f.kort ? T.abonnement.kort(f.kort.maerke, f.kort.sidste4) : null;

  // Alle ledige uger op til 52 uger frem (staff_maks_uger_frem) - ikke kun
  // de 8 i kalenderen.
  const ledigeUger: LedigUge[] = ugens
    ? ugens.ledige.map((u) => ({
        uge_start: u.uge_start,
        uge_nr: u.uge_nr,
        aar: u.aar,
        inkl_oere: u.pris?.inkl_oere ?? null,
        rabat_procent: u.pris?.rabat_procent ?? 0,
        denne_uge: u.uge_start === ugens.denneUge,
      }))
    : [];
  // Som ugens_butik_staff_book: uden betaling kan bookes for alle konti, der
  // ikke er lukket (også pause/suspenderet - feltet vises først på forsiden,
  // når firmaet er aktivt). Med betaling kun for et aktivt firma.
  const ugeSpaerret = lukket ? T.hurtig.uge.underIkkeAktiv : null;
  const medBetalingMulig = !lukket && !suspenderet && status === "aktiv";

  const fanHref = (x: Fane) => `/admin/erhverv/firmaer/${f.id}?fane=${x}`;

  // --- Kræver handling -----------------------------------------------------------
  const punkter: KraeverPunkt[] = [];
  if (lukket) punkter.push({ id: "lukket", tone: "roed", tekst: T.kraever.lukket, handling: <FaneLink href={`${fanHref("log")}#firmakonto`}>{T.kraever.seNoterOgLog}</FaneLink> });
  else if (suspenderet)
    punkter.push({ id: "susp", tone: "roed", tekst: T.kraever.suspenderet, handling: <FaneLink href={`${fanHref("log")}#firmakonto`}>{T.kraever.seNoterOgLog}</FaneLink> });
  if (lukningForslag && !lukket)
    punkter.push({ id: "lukforslag", tone: "roed", tekst: T.kraever.lukningForslag, handling: <FaneLink href={`${fanHref("log")}#firmakonto`}>{T.kraever.seNoterOgLog}</FaneLink> });
  if (f.betaling_mislykket_kl)
    punkter.push({
      id: "betaling",
      tone: "roed",
      tekst: T.kraever.betalingFejlet(datoTid(f.betaling_mislykket_kl)),
      handling: <FaneLink href={fanHref("regninger")}>{T.kraever.seRegninger}</FaneLink>,
    });
  if (status === "pauset")
    punkter.push({
      id: "pause",
      tone: "gul",
      tekst: f.pauset_aarsag === "betaling" ? T.kraever.pauseBetaling : T.kraever.pauseBidhamr,
      handling: f.pauset_aarsag === "betaling" ? undefined : <GenaktiverKnap firmaId={f.id} />,
    });
  if (status === "afventer_betaling") punkter.push({ id: "afventer", tone: "gul", tekst: T.kraever.afventerBetaling });
  if (opsiges && f.opsiges_fra)
    punkter.push({
      id: "opsiges",
      tone: "gul",
      tekst: T.kraever.opsiges(dato(f.opsiges_fra)),
      handling: <FirmaAbonnementStripe firmaId={f.id} harAbonnement={!!f.stripe_subscription_id} opsiges={dato(f.opsiges_fra)} opsagt={false} />,
    });
  if (!f.har_logget_ind && !lukket)
    punkter.push({
      id: "login",
      tone: "gul",
      tekst: T.kraever.ikkeLoggetInd,
      handling: <EtKlikKnap firmaId={f.id} handling="gensendVelkomst" label={T.kraever.sendVelkomst} className="btn btn-sekundaer btn-lille" />,
    });
  if (f.kort?.udloeber_snart && !lukket && status !== "opsagt" && kortTekst)
    punkter.push({
      id: "kort",
      tone: "gul",
      tekst: T.kraever.kortUdloeber(`${kortTekst}, ${f.kort.udloeb}`),
      handling: <EtKlikKnap firmaId={f.id} handling="kortMail" label={T.kraever.sendKortMail} className="btn btn-sekundaer btn-lille" />,
    });
  if (f.afventende_opgradering) punkter.push({ id: "opgradering", tone: "gul", tekst: T.kraever.afventerOpgradering(f.afventende_opgradering.navn) });
  if (aabneKlager > 0)
    punkter.push({
      id: "klager",
      tone: "gul",
      tekst: T.kraever.aabneKlager(aabneKlager),
      handling: <FaneLink href={`/admin/erhverv/klager?status=aaben&firma=${f.id}`}>{T.kraever.seKlager}</FaneLink>,
    });
  if (forslag.length > 0)
    punkter.push({ id: "advarsel", tone: "gul", tekst: T.kraever.advarselForslag, handling: <FaneLink href={`${fanHref("log")}#forslag`}>{T.kraever.seNoterOgLog}</FaneLink> });
  for (const b of ugens?.bookinger ?? []) {
    if (b.status === "reserveret" && b.reserveret_til && new Date(b.reserveret_til).getTime() > nu) {
      punkter.push({
        id: `uge-${b.id}`,
        tone: "gul",
        tekst: T.kraever.ugeVenter(ugeNr(b.uge_start), datoTid(b.reserveret_til)),
        handling: <UgeHandlinger b={b} />,
      });
    }
    if (b.kraever_opmaerksomhed) {
      punkter.push({
        id: `uge-ops-${b.id}`,
        tone: "roed",
        tekst: (
          <>
            {T.kraever.ugeOpmaerksomhed(ugeNr(b.uge_start))}
            {b.opmaerksomhed_tekst && <span className="block text-tekst-daempet">{b.opmaerksomhed_tekst}</span>}
          </>
        ),
        handling: <FaneLink href={fanHref("ugens-butik")}>{T.kraever.seUgensButik}</FaneLink>,
      });
    }
  }

  const adresse = [f.adresse, `${f.postnummer} ${f.bynavn}`].filter(Boolean).join(", ");

  return (
    <AdminSide>
      <AdminSideHoved
        tilbage={{ href: "/admin/erhverv/firmaer", label: X.tilbageTilFirmaer }}
        titel={f.firmanavn}
        forklaring={
          <span className="break-words">
            {A.firmaer.kolonneCvr} {f.cvr} · {adresse} · {f.kontakt_email} · {visTelefon(f.telefon)}
          </span>
        }
        handlinger={
          <>
            <Link href={`/erhvervssaelger/${f.bruger_id}`} className="btn btn-sekundaer btn-lille">
              {T.seButik}
            </Link>
            <a href={`mailto:${f.kontakt_email}`} className="btn btn-sekundaer btn-lille">
              {T.sendMail}
            </a>
          </>
        }
      />

      <FirmaStatuslinje
        celler={[
          {
            label: T.status.titel,
            vaerdi: (
              <>
                <StatusLampe tone={lampe} />
                {statusTekst}
              </>
            ),
            under: opsiges && f.opsiges_fra ? T.status.opsigesFra(dato(f.opsiges_fra)) : f.betaling_mislykket_kl ? T.status.betalingFejlet : undefined,
          },
          {
            label: T.status.pakke,
            vaerdi: f.pakke?.navn ?? T.status.ingenPakke,
            under:
              pris != null
                ? `${kr(pris)} ${T.status.eksklMoms}${f.saerpris != null ? ` (${T.abonnement.saerpris.toLowerCase()})` : ""}`
                : undefined,
          },
          {
            label: T.status.auktioner,
            vaerdi: kvote ? (kvote.max == null ? T.status.brugtUbegraenset(kvote.brugt) : T.status.brugtAf(kvote.brugt, kvote.max)) : "–",
            under: [
              `${f.aktive_auktioner} ${X.aktiveAuktioner.toLowerCase()}`,
              kvote && !kvote.ubegraenset && kvote.ekstra > 0 ? T.status.ekstra(kvote.ekstra) : null,
            ]
              .filter(Boolean)
              .join(" · "),
          },
          {
            label: T.status.naesteBetaling,
            vaerdi:
              lukket || status === "opsagt" || opsiges || !f.stripe_subscription_id
                ? T.status.ingenBetaling
                : gratisTil
                  ? T.status.gratisTil(dato(gratisTil))
                  : naestePris != null
                    ? krFraOere(Math.round(naestePris * 100))
                    : "–",
            under:
              lukket || status === "opsagt"
                ? T.status.opsagt
                : opsiges && f.opsiges_fra
                  ? T.status.opsigesFra(dato(f.opsiges_fra))
                  : !f.stripe_subscription_id
                    ? f.gratis_maaneder_ved_start > 0
                      ? `${T.status.ikkeIStripe} · ${T.status.gratisVedStart(f.gratis_maaneder_ved_start)}`
                      : T.status.ikkeIStripe
                    : gratisTil && naestePris != null
                      ? `${T.status.derefter(krFraOere(Math.round(naestePris * 100)))}${introGaelder && intro ? ` ${T.status.medIntro(intro.procent)}` : ""}`
                      : naesteDato
                        ? `${dato(naesteDato)} · ${T.status.eksklMoms}${introGaelder && intro ? ` · ${T.status.medIntro(intro.procent)}` : ""}`
                        : T.status.eksklMoms,
          },
        ]}
      />

      <FirmaKraeverHandling punkter={punkter} />

      <FirmaHurtighandlinger
        firmaId={f.id}
        pakkeId={f.pakke_id}
        pakkeNavn={f.pakke?.navn ?? T.status.ingenPakke}
        pakkePris={pakkePris}
        pakker={pakker}
        lukket={lukket}
        abonnement={{
          saerpris: f.saerpris ?? null,
          gratisTil: gratisTil ? dato(gratisTil) : null,
          gratisVedStart: f.gratis_maaneder_ved_start ?? 0,
          intro,
          // "Behold Starts gratis måned + introrabat" kan vælges (20261102450000).
          beholdGratisMulig: f.behold_gratis_mulig === true,
          // Planlagt eller kører: så kan der ikke gives særpris (Filip, 27. okt. 2026).
          introAktiv: !!intro && introNu !== "slut",
          ekstraAuktioner: kvote?.ekstra ?? 0,
          ekstraFremh: f.fremhaevninger?.ekstra ?? 0,
          ubegraenset: !!kvote?.ubegraenset,
        }}
        status={status}
        opsiges={opsiges}
        ledigeUger={ugens ? ledigeUger : null}
        kanBookeUge={ugeSpaerret}
        medBetalingMulig={medBetalingMulig}
        rabat={ugens?.rabatIndstilling ?? null}
      />

      <AdminFaner
        label="Firma"
        aktiv={fane}
        faner={[
          { id: "abonnement", label: T.faner.abonnement, href: fanHref("abonnement") },
          { id: "kvoter", label: T.faner.kvoter, href: fanHref("kvoter") },
          { id: "ugens-butik", label: T.faner.ugensButik, href: fanHref("ugens-butik") },
          { id: "oplysninger", label: T.faner.oplysninger, href: fanHref("oplysninger") },
          { id: "salg", label: T.faner.salg, href: fanHref("salg") },
          { id: "regninger", label: T.faner.regninger, href: fanHref("regninger") },
          { id: "log", label: T.faner.log, href: fanHref("log"), antal: forslag.length + (lukningForslag ? 1 : 0), tone: "gul" },
        ]}
      />

      {fane === "abonnement" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Felt titel={T.abonnement.titel}>
            <Raekker
              raekker={[
                [T.abonnement.pakke, f.pakke?.navn ?? T.status.ingenPakke],
                [T.abonnement.standardpris, pakkePris != null ? `${kr(pakkePris)} ${T.status.eksklMoms}` : X.prisIkkeSat],
                [T.abonnement.status, statusTekst],
                [T.abonnement.start, dato(f.abonnement_start)],
                [
                  T.abonnement.naesteSkift,
                  f.naeste_pakke && f.naeste_pakke_fra
                    ? X.planlagtSkift(f.naeste_pakke.navn, dato(f.naeste_pakke_fra))
                    : f.afventende_opgradering
                      ? X.afventerOpgradering(f.afventende_opgradering.navn)
                      : T.abonnement.ingen,
                ],
              ]}
            />
            {rolle === "chef" && (
              <Link href="/admin/erhverv/pakker" className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-groen hover:underline sm:min-h-9">
                {T.abonnement.retPriser} →
              </Link>
            )}
          </Felt>
          <Felt titel={T.abonnement.stripeTitel}>
            {f.stripe_subscription_id ? (
              <Raekker
                raekker={[
                  [
                    AB.stripeStatus,
                    f.stripe_abonnement_status
                      ? (AB.stripeStatusNavn[f.stripe_abonnement_status] ?? f.stripe_abonnement_status)
                      : "–",
                  ],
                  [AB.betaltTil, f.betalt_til ? dato(f.betalt_til) : "–"],
                  [T.abonnement.periodeSlut, f.periode_slut ? dato(f.periode_slut) : "–"],
                ]}
              />
            ) : (
              <p className="text-sm text-tekst-daempet">{AB.ingenAbonnement}</p>
            )}
            {f.opsiges_fra && (
              <p className="mt-3 border border-info-kant bg-info-bg px-3 py-2 text-sm text-info-tekst">{AB.opsigesFra(dato(f.opsiges_fra))}</p>
            )}
            <div className="mt-3">
              <FirmaAbonnementStripe
                firmaId={f.id}
                harAbonnement={!!f.stripe_subscription_id}
                opsiges={f.opsiges_fra ? dato(f.opsiges_fra) : null}
                opsagt={status === "opsagt"}
              />
            </div>
          </Felt>
          <Felt titel={T.abonnement.prisTitel}>
            <Raekker
              raekker={[
                [T.abonnement.firmaetBetaler, pris != null ? T.abonnement.prisPrMaaned(kr(pris)) : X.prisIkkeSat],
                [T.abonnement.saerpris, f.saerpris != null ? T.abonnement.prisPrMaaned(kr(f.saerpris)) : T.abonnement.ingen],
                ...(f.saerpris != null && f.saerpris_aftale
                  ? ([[T.abonnement.saerprisAftale, f.saerpris_aftale]] as [string, string][])
                  : []),
                [
                  T.abonnement.introrabat,
                  intro && introNu ? (
                    <>
                      {T.abonnement.introTekst(intro.procent, intro.maaneder, intro.fra, intro.behold_gratis === true)}
                      <span className="block font-normal text-tekst-daempet">
                        {T.abonnement.introStatus(introNu, intro.til ? dato(intro.til) : null)}
                      </span>
                    </>
                  ) : (
                    T.abonnement.ingen
                  ),
                ],
                [
                  T.abonnement.gratis,
                  gratisTil
                    ? T.abonnement.gratisTil(dato(gratisTil))
                    : f.gratis_maaneder_ved_start > 0
                      ? T.abonnement.gratisVedStart(f.gratis_maaneder_ved_start)
                      : f.gratis_brugt
                        ? T.abonnement.gratisBrugt
                        : T.abonnement.ingen,
                ],
              ]}
            />
          </Felt>
          <Felt titel={T.abonnement.kortTitel}>
            {f.kort && kortTekst ? (
              <>
                <Raekker
                  raekker={[
                    [T.abonnement.kortTitel, kortTekst],
                    [
                      T.abonnement.kortUdloeb,
                      f.kort.udloeber_snart ? (
                        <span className="text-advarsel-tekst">
                          {f.kort.udloeb} · {T.abonnement.kortUdloeberSnart}
                        </span>
                      ) : (
                        f.kort.udloeb
                      ),
                    ],
                  ]}
                />
                {!lukket && (
                  <div className="mt-3">
                    <EtKlikKnap firmaId={f.id} handling="kortMail" label={T.kraever.sendKortMail} className="btn btn-sekundaer btn-lille" />
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-tekst-daempet">{T.abonnement.ingenKort}</p>
            )}
          </Felt>
        </div>
      )}

      {fane === "kvoter" && (
        <FaneKvoter kvote={kvote} fremh={f.fremhaevninger ?? null} fremhaevninger={fremhaevninger} ugens={ugens} />
      )}

      {fane === "ugens-butik" && (
        <FaneUgensButik
          firmaId={f.id}
          ugens={ugensSvar}
          ledigeUger={ledigeUger}
          kanBooke={!ugeSpaerret}
          medBetalingMulig={medBetalingMulig}
          visesNu={visesNuBruger === f.bruger_id}
        />
      )}

      {fane === "oplysninger" && (
        <div className="space-y-4">
          <Felt titel={T.oplysninger.konto}>
            <Raekker
              raekker={[
                [X.felter.loginEmail, f.login_email],
                [X.felter.loggetInd, f.har_logget_ind ? X.ja : X.nej],
                [X.oprettetAf, `${f.oprettet_af_navn ?? "–"} (${datoTid(f.oprettet_kl)})`],
              ]}
            />
            {f.henvendelse_id && (
              <Link
                href={`/admin/erhverv/henvendelser/${f.henvendelse_id}`}
                className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-groen hover:underline sm:min-h-9"
              >
                {A.henvendelser.titel} →
              </Link>
            )}
          </Felt>
          <Felt titel={T.oplysninger.titel}>
            <FirmaRedigering
              firmaId={f.id}
              harLoggetInd={f.har_logget_ind}
              start={{
                firmanavn: f.firmanavn,
                cvr: f.cvr,
                adresse: f.adresse,
                postnummer: f.postnummer,
                by: f.bynavn,
                telefon: f.telefon,
                kontaktEmail: f.kontakt_email,
                kontaktperson: f.kontaktperson,
              }}
            />
          </Felt>
        </div>
      )}

      {fane === "salg" && <FaneSalg data={salg} />}

      {fane === "regninger" && <FaneRegninger regninger={regninger} ugens={ugens} />}

      {fane === "log" && (
        <div className="space-y-4">
          <Felt titel={T.log.noteTitel}>
            <FirmaNote firmaId={f.id} />
          </Felt>
          {forslag.length > 0 && (
            <Felt titel={`${T.log.forslagTitel} (${forslag.length})`} id="forslag">
              <p className="mb-3 text-sm text-tekst-daempet">{KLAGE_ADMIN.forslagForklaring(KLAGE_FORSLAG_ANTAL, KLAGE_FORSLAG_MAANEDER)}</p>
              <ul className="space-y-3">
                {forslag.map((x) => (
                  <li key={x.id} className="border border-kant p-3">
                    <p className="text-sm text-tekst-daempet">
                      {KLAGE_ADMIN.forslagGrundlag[x.grundlag](x.antal_klager)} · {KLAGE_ADMIN.advarslerAntal(x.advarsler_antal)} · {datoTid(x.oprettet_kl)}
                    </p>
                    <div className="mt-3">
                      <AdvarselForslagHandlinger forslagId={x.id} />
                    </div>
                  </li>
                ))}
              </ul>
            </Felt>
          )}
          <Felt titel={T.log.klagerTitel}>
            <KlageListe klager={klager} firmaId={f.id} />
          </Felt>
          {konto && <FirmaKontoSektion firmaId={f.id} konto={konto} forslag={lukningForslag ?? null} />}
          <Felt titel={T.log.logTitel}>
            <LogListe log={log} />
          </Felt>
        </div>
      )}
    </AdminSide>
  );
}
