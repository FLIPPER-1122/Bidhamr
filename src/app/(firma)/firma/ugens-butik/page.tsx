import Link from "next/link";
import { kraevFirma } from "@/lib/erhverv/firmaData";
import { createClient } from "@/lib/supabase/server";
import { foerLancering } from "@/lib/lancering";
import { logDriftFejl } from "@/lib/drift";
import { synkUgensButikRetur } from "@/lib/betaling/ugensButik";
import { hentMineFakturaer } from "@/lib/faktura/data";
import FakturaListe from "@/components/faktura/FakturaListe";
import { FirmaSide, Kort, LukketBoks } from "@/components/firma/dele";
import UgensButikKoeb, { type FirmaUgensButikData } from "@/components/firma/UgensButikKoeb";
import { E_KNAP_SEKUNDAER, E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";
import { krFraOere, langDato } from "@/lib/erhverv/visning";
import { UGENS_FIRMA as T } from "@/lib/tekster/ugensButik";
import { antalVisbareAuktioner, ugensButikVisesNu } from "@/lib/erhverv/ugensButikVisning";

// Firma oversigt -> Ugens butik (Filip, 26. okt. 2026; showcase
// dit-firma-showcase.html, fanen "Ugens butik"). Forklaring, pris (med
// pakkens rabat), kalender over den igangværende uge og 12 uger frem,
// booking med Stripes Payment Element, annullering af en åben reservation,
// egne uger og fakturaer. Data: firma_ugens_butik (auth.uid() i databasen).
// Køb og annullering går via /api/offentlig (ikke server actions), så det
// også virker før lancering - serveren svarer så med koden foer_lancering.
//   ?payment_intent=pi_...  retur fra betalingen (3D Secure, MobilePay ...)

export const metadata = { title: T.titel };

type Retur = "betalt" | "behandles" | "mislykket" | "refunderes";

function ugeNrAf(iso: string): number {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
}

function Boks({ titel, tekst, farve }: { titel: string; tekst: string; farve: "succes" | "info" | "fejl" | "advarsel" }) {
  const klasser = {
    succes: "border-succes-kant bg-succes-bg text-succes-tekst",
    info: "border-info-kant bg-info-bg text-info-tekst",
    advarsel: "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst",
    fejl: "border-fejl-kant bg-fejl-bg text-fejl-tekst",
  }[farve];
  return (
    <div role={farve === "fejl" ? "alert" : "status"} className={`rounded-none border-2 p-5 ${klasser}`}>
      <p className="text-[21px] font-semibold">{titel}</p>
      <p className="mt-1 text-[18px]">{tekst}</p>
    </div>
  );
}

export default async function FirmaUgensButik({
  searchParams,
}: {
  searchParams: Promise<{ payment_intent?: string }>;
}) {
  const { bruger, oversigt } = await kraevFirma("/firma/ugens-butik");
  const sp = await searchParams;
  const lukket = foerLancering();

  // Retur fra betalingen: spejl PaymentIntenten med det samme (webhooken gør
  // det samme - idempotent), FØR siden læser ugerne, så kvitteringen passer.
  let retur: Retur | null = null;
  let returUge: string | null = null;
  let returKode: string | null = null;
  if (typeof sp.payment_intent === "string" && sp.payment_intent) {
    const r = await synkUgensButikRetur(bruger.id, sp.payment_intent);
    returUge = r.uge;
    returKode = r.kode;
    if (r.kode === "betalt" || r.kode === "allerede") retur = "betalt";
    else if (r.kode === null || r.kode === "behandles") retur = "behandles";
    else if (r.kode === "afventer") retur = "mislykket";
    else if (r.kode === "for_sent" || r.kode === "beloeb_afviger" || r.kode === "kasseret") retur = "refunderes";
  }

  const supabase = await createClient();
  const [{ data, error }, fakturaer, visbare, visesNu] = await Promise.all([
    supabase.rpc("firma_ugens_butik"),
    hentMineFakturaer(supabase),
    // Feltet på forsiden vises kun, mens firmaet har aktive auktioner.
    antalVisbareAuktioner(bruger.id),
    ugensButikVisesNu(),
  ]);
  const visesDetNu = visesNu === bruger.id;
  // Hvorfor vises firmaets igangværende uge ikke? (forside_ugens_butik)
  const ikkeVistTekst =
    oversigt.firma.abonnement_status !== "aktiv"
      ? T.visesIkkeAbonnement
      : visbare === 0
        ? T.visesIkkeAuktioner
        : T.visesIkke;
  if (error || !data) {
    if (error) await logDriftFejl({ kilde: "server", hvor: "firma/ugens-butik", fejl: error, brugerId: bruger.id });
    throw new Error(T.hentFejl);
  }
  const d = data as FirmaUgensButikData;

  // En returkode uden klar besked ('uaendret' o.l.): ugens tilstand afgør det.
  if (!retur && returKode && returKode !== "ikke_fundet" && returUge) {
    if (d.bookinger.some((b) => b.uge_start === returUge && (b.status === "betalt" || b.status === "manuel"))) retur = "betalt";
    else if (d.aaben?.status === "behandles") retur = "behandles";
    else retur = "mislykket";
  }

  const ugensFakturaer = (fakturaer ?? []).filter(
    (f) => !f.trade_id && f.linjer.some((l) => l.tekst.startsWith("Ugens butik")),
  );
  const aar = Number(d.denne_uge.slice(0, 4));
  const r = d.rabat;

  return (
    <FirmaSide titel={T.titel} intro={T.intro}>
      {lukket && <LukketBoks tekst={T.fejl.foer_lancering} />}

      {retur === "betalt" && (
        <Boks farve="succes" titel={T.retur.betaltTitel} tekst={T.retur.betaltTekst(returUge ? ugeNrAf(returUge) : 0)} />
      )}
      {retur === "behandles" && <Boks farve="info" titel={T.retur.behandlesTitel} tekst={T.retur.behandlesTekst} />}
      {retur === "mislykket" && <Boks farve="fejl" titel={T.retur.mislykketTitel} tekst={T.retur.mislykketTekst} />}
      {retur === "refunderes" && <Boks farve="advarsel" titel={T.retur.refunderesTitel} tekst={T.retur.refunderesTekst} />}

      <Kort id="forklaring" titel={T.forklaringTitel}>
        <ul className="list-disc space-y-2 pl-6">
          {T.forklaring.map((l) => (
            <li key={l} className={E_TEKST}>
              {l}
            </li>
          ))}
        </ul>
      </Kort>

      <Kort id="pris" titel={T.prisTitel}>
        <p className="text-[26px] leading-tight font-bold text-tekst tabular-nums">{T.prisEkskl(krFraOere(d.pris.ekskl_moms_oere))}</p>
        <p className={`mt-1 ${E_TEKST}`}>{T.prisInkl(krFraOere(d.pris.inkl_moms_oere))}</p>
        {r && r.procent > 0 && r.antal_pr_aar > 0 ? (
          <div className="mt-4 rounded-none bg-groen-lys p-4">
            <p className="text-[18px] font-semibold text-groen-mork">{T.rabatLinje(r.procent, r.antal_pr_aar)}</p>
            <p className="mt-1 text-[17px] text-groen-mork">{T.rabatTilbage(r.tilbage_i_aar, aar)}</p>
          </div>
        ) : (
          <p className={`mt-4 ${E_TEKST_DAEMPET}`}>{T.ingenRabat}</p>
        )}
      </Kort>

      <UgensButikKoeb data={d} ingenAuktioner={visbare === 0} />

      <Kort id="dine-uger" titel={T.bookingerTitel}>
        {d.bookinger.length === 0 ? (
          <p className={E_TEKST}>{T.bookingerTom}</p>
        ) : (
          <ul className="divide-y divide-kant rounded-none border border-kant">
            {d.bookinger.map((b) => (
              <li key={b.id} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-[19px] font-semibold text-tekst">
                    {T.uge(b.uge_nr)} <span className="font-normal text-tekst-daempet">({b.aar})</span>
                    {b.aktiv_nu && visesDetNu && (
                      <span className="ml-2 inline-block bg-groen px-2 py-0.5 align-middle text-[14px] font-semibold text-white">
                        {T.aktivNu}
                      </span>
                    )}
                  </p>
                  {b.aktiv_nu && !visesDetNu && (
                    <p className="mt-1 inline-block border-2 border-advarsel-kant bg-advarsel-bg px-2 py-0.5 text-[15px] font-semibold text-advarsel-tekst">
                      {ikkeVistTekst}
                    </p>
                  )}
                  <p className={E_TEKST_DAEMPET}>
                    {T.fraTil(langDato(b.start_kl), langDato(new Date(new Date(b.slut_kl).getTime() - 1).toISOString()))}
                  </p>
                  <p className={E_TEKST_DAEMPET}>
                    {T.bookingStatus[b.status] ?? b.status}
                    {b.betalt_kl && ` · ${T.betaltDen(langDato(b.betalt_kl))}`}
                    {b.refunderet_kl && ` · ${T.refunderetDen(langDato(b.refunderet_kl))}`}
                  </p>
                </div>
                <p className="shrink-0 text-[19px] font-semibold text-tekst tabular-nums">
                  {b.status === "manuel" || b.beloeb_oere === 0 ? T.udenBetaling : krFraOere(b.beloeb_oere)}
                  {b.rabat_procent > 0 && (
                    <span className="block text-[15px] font-normal text-tekst-daempet sm:text-right">{T.rabatIUgen(b.rabat_procent)}</span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Kort>

      <Kort id="fakturaer" titel={T.fakturaTitel} forklaring={T.fakturaIntro}>
        {fakturaer === null ? (
          <p role="alert" className={E_TEKST}>
            {T.fakturaFejl}
          </p>
        ) : ugensFakturaer.length === 0 ? (
          <p className={E_TEKST}>{T.fakturaTom}</p>
        ) : (
          <FakturaListe fakturaer={ugensFakturaer} visHandel={false} />
        )}
        <div className="mt-5">
          <Link href="/firma/regninger" className={`${E_KNAP_SEKUNDAER} w-full sm:w-auto`}>
            {T.alleRegninger}
          </Link>
        </div>
      </Kort>
    </FirmaSide>
  );
}
