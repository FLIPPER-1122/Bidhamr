"use client";

// Kalender og køb af Ugens butik i Firma oversigt (/firma/ugens-butik).
// Firmaet vælger en ledig uge; serveren reserverer den i 30 minutter, låser
// prisen (med pakkens rabat) og laver PaymentIntenten på BidHamrs
// platformskonto (POST /api/offentlig/firma-ugens-butik-koeb - ikke en
// server action, så det også virker før lancering). Her vises Stripes
// Payment Element (kort, MobilePay, Revolut Pay, Apple Pay, Google Pay;
// tvungen 3D Secure). Ugen er først firmaets, når Stripe har bekræftet
// betalingen (webhook eller returen til siden) - aldrig fra browseren.
// Kun Stripes testnøgler indtil fase 6 (src/lib/stripeKlient.ts).
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { PAYMENT_ELEMENT_WALLETS } from "@/lib/betaling/betalingsmetoder";
import { hentStripe, stripeUdseende } from "@/lib/stripeKlient";
import { kaldOffentligHandling } from "@/lib/offentligHandling";
import StripeIndlaesningsfejl from "@/components/betaling/StripeIndlaesningsfejl";
import { Kort } from "@/components/firma/dele";
import { E_KNAP_PRIMAER, E_KNAP_SEKUNDAER, E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";
import { krFraOere } from "@/lib/erhverv/visning";
import { UGENS_FIRMA as T } from "@/lib/tekster/ugensButik";

export type UgeStatus = "ledig" | "optaget" | "din" | "din_reservation" | "loft";

export type FirmaUgensButikData = {
  pris: { ekskl_moms_oere: number; moms_oere: number; inkl_moms_oere: number };
  reservation_minutter: number;
  loft: { maks_uger_i_traek: number; pause_uger: number };
  rabat: { procent: number; antal_pr_aar: number; brugt_i_aar: number; tilbage_i_aar: number } | null;
  kan_koebe: boolean;
  grund: string | null;
  denne_uge: string;
  uger: {
    uge_start: string;
    uge_nr: number;
    aar: number;
    start_kl: string;
    slut_kl: string;
    igangvaerende: boolean;
    status: UgeStatus;
    pris_inkl_moms_oere: number;
    pris_ekskl_moms_oere: number;
    rabat_procent: number;
  }[];
  aaben: {
    id: string;
    uge_start: string;
    uge_nr: number;
    status: "reserveret" | "behandles";
    kilde: "firma" | "staff";
    reserveret_til: string | null;
    beloeb_oere: number;
    rabat_procent: number;
  } | null;
  bookinger: {
    id: string;
    uge_start: string;
    uge_nr: number;
    aar: number;
    start_kl: string;
    slut_kl: string;
    status: string;
    kilde: "firma" | "staff";
    beloeb_oere: number;
    rabat_procent: number;
    rabat_oere: number;
    betalt_kl: string | null;
    refunderet_kl: string | null;
    aktiv_nu: boolean;
  }[];
};

type Start = {
  bookingId: string;
  uge: string;
  clientSecret: string;
  beloebOere: number;
  rabatProcent: number;
  reserveretTil: string | null;
};
type KoebSvar = ({ ok: true } & Start) | { fejl: string; kode: string };

const TZ = "Europe/Copenhagen";

// "2. nov."
function kortDato(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("da-DK", { day: "numeric", month: "short", timeZone: TZ });
}
// Søndagen i ugen.
function soendag(mandag: string): string {
  const d = new Date(`${mandag.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}
// "26. oktober kl. 14.32"
function tidspunkt(iso: string): string {
  const d = new Date(iso);
  const dato = d.toLocaleDateString("da-DK", { day: "numeric", month: "long", timeZone: TZ });
  const kl = d.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  return `${dato} kl. ${kl}`;
}

const STATUS_KLASSE: Record<UgeStatus, string> = {
  ledig: "border-kant-staerk bg-white text-tekst hover:border-groen",
  optaget: "border-kant bg-[#F1F3F2] text-tekst-svag",
  din: "border-groen bg-groen text-white",
  din_reservation: "border-orange-knap bg-orange-lys text-advarsel-tekst",
  loft: "border-kant bg-[#F1F3F2] text-tekst-svag",
};

export default function UgensButikKoeb({ data }: { data: FirmaUgensButikData }) {
  const router = useRouter();
  const aabenReserveret = data.aaben?.status === "reserveret" ? data.aaben : null;
  const foersteLedige = data.uger.find((u) => u.status === "ledig")?.uge_start ?? null;
  const [valgt, setValgt] = useState<string | null>(aabenReserveret?.uge_start ?? foersteLedige);
  const [start, setStart] = useState<Start | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const [henter, setHenter] = useState(false);
  const [annullerer, setAnnullerer] = useState(false);
  const [sender, setSender] = useState(false);
  const [besked, setBesked] = useState<string | null>(null);
  const fejlRef = useRef<HTMLParagraphElement>(null);
  const betalRef = useRef<HTMLDivElement>(null);

  const valgtUge = data.uger.find((u) => u.uge_start === valgt) ?? null;
  const harLoft = data.uger.some((u) => u.status === "loft");
  const kanVaelges = (s: UgeStatus) => s === "ledig" || s === "din_reservation";

  function visFejl(t: string) {
    setFejl(t);
    window.requestAnimationFrame(() => fejlRef.current?.focus());
  }

  function vaelg(uge: string) {
    if (henter || sender || uge === valgt) return;
    setValgt(uge);
    // Betalingen for den forrige uge skjules; serveren skifter reservationen,
    // når firmaet trykker "Book" igen.
    setStart(null);
    setFejl(null);
    setBesked(null);
  }

  async function koeb(uge: string) {
    if (henter) return;
    setHenter(true);
    setFejl(null);
    setBesked(null);
    const fd = new FormData();
    fd.set("uge", uge);
    const r = await kaldOffentligHandling<KoebSvar>("firma-ugens-butik-koeb", fd);
    setHenter(false);
    if ("ok" in r && r.ok && r.clientSecret) {
      setValgt(r.uge);
      setStart({
        bookingId: r.bookingId,
        uge: r.uge,
        clientSecret: r.clientSecret,
        beloebOere: r.beloebOere,
        rabatProcent: r.rabatProcent,
        reserveretTil: r.reserveretTil,
      });
      window.requestAnimationFrame(() => betalRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
      return;
    }
    const kode = "kode" in r ? r.kode : "fejl";
    visFejl(T.fejl[kode] ?? ("fejl" in r && r.fejl ? r.fejl : T.fejl.fejl));
    // Kalenderen kan have ændret sig (taget, betalt, behandles).
    if (kode === "optaget" || kode === "betalt" || kode === "behandles" || kode === "aaben_reservation") router.refresh();
  }

  async function annuller(bookingId: string) {
    if (annullerer) return;
    setAnnullerer(true);
    setFejl(null);
    const fd = new FormData();
    fd.set("bookingId", bookingId);
    const r = await kaldOffentligHandling<{ ok: true } | { fejl: string; kode: string }>("firma-ugens-butik-annuller", fd);
    setAnnullerer(false);
    if ("ok" in r && r.ok) {
      setStart(null);
      setBesked(T.annulleret);
      router.refresh();
      return;
    }
    const kode = "kode" in r ? r.kode : "fejl";
    visFejl(T.fejl[kode] ?? T.fejl.fejl);
    router.refresh();
  }

  const bookingId = start?.bookingId ?? aabenReserveret?.id ?? null;

  return (
    <>
      {data.aaben && !start && (
        <div role="status" className="rounded-none border-2 border-advarsel-kant bg-advarsel-bg p-5 text-advarsel-tekst">
          <p className="text-[21px] font-semibold">{T.aabenTitel}</p>
          {data.aaben.status === "behandles" ? (
            <p className="mt-1 text-[18px]">{T.aabenBehandles}</p>
          ) : (
            <>
              <p className="mt-1 text-[18px]">
                {T.aabenTekst(
                  data.aaben.uge_nr,
                  krFraOere(data.aaben.beloeb_oere),
                  data.aaben.reserveret_til ? tidspunkt(data.aaben.reserveret_til) : null,
                )}
              </p>
              {data.aaben.kilde === "staff" && <p className="mt-1 text-[17px]">{T.aabenFraBidhamr}</p>}
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <button
                  type="button"
                  onClick={() => koeb(data.aaben!.uge_start)}
                  disabled={henter || annullerer}
                  aria-busy={henter || undefined}
                  className={`${E_KNAP_PRIMAER} w-full sm:w-auto`}
                >
                  {henter && <span className="btn-spinner" aria-hidden="true" />}
                  {henter ? T.starter : T.aabenBetal}
                </button>
                <button
                  type="button"
                  onClick={() => annuller(data.aaben!.id)}
                  disabled={henter || annullerer}
                  aria-busy={annullerer || undefined}
                  className={`${E_KNAP_SEKUNDAER} w-full sm:w-auto`}
                >
                  {annullerer && <span className="btn-spinner" aria-hidden="true" />}
                  {T.aabenAnnuller}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <Kort id="kalender" titel={T.kalenderTitel} forklaring={T.kalenderForklaring}>
        <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {data.uger.map((u) => {
            const kan = kanVaelges(u.status);
            const er = u.uge_start === valgt;
            const indhold = (
              <>
                <span className="block text-[19px] leading-tight font-bold">
                  {T.uge(u.uge_nr)}
                  {u.igangvaerende && <span className="block text-[14px] font-semibold">{T.denneUge}</span>}
                </span>
                <span className="block text-[15px]">{T.fraTil(kortDato(u.uge_start), kortDato(soendag(u.uge_start)))}</span>
                <span className="mt-1 block text-[15px] font-semibold">{T.status[u.status] ?? u.status}</span>
                {u.status === "ledig" && (
                  <span className="block text-[15px] tabular-nums">
                    {krFraOere(u.pris_inkl_moms_oere)}
                    {u.rabat_procent > 0 && ` · ${T.rabatIUgen(u.rabat_procent)}`}
                  </span>
                )}
              </>
            );
            return (
              <li key={u.uge_start}>
                {kan ? (
                  <button
                    type="button"
                    onClick={() => vaelg(u.uge_start)}
                    aria-pressed={er}
                    disabled={henter || sender}
                    className={`h-full min-h-[120px] w-full rounded-none border-2 p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
                      STATUS_KLASSE[u.status]
                    } ${er ? "ring-4 ring-groen ring-offset-1" : ""}`}
                  >
                    {indhold}
                  </button>
                ) : (
                  <div className={`h-full min-h-[120px] rounded-none border-2 p-3 ${STATUS_KLASSE[u.status]}`}>{indhold}</div>
                )}
              </li>
            );
          })}
        </ul>
        <p className={`mt-4 ${E_TEKST_DAEMPET}`}>{T.forklaringFarver}</p>
        {harLoft && <p className={`mt-1 ${E_TEKST_DAEMPET}`}>{T.loftForklaring}</p>}

        <div className="mt-6 border-t border-kant pt-5" ref={betalRef}>
          {!data.kan_koebe ? (
            <div>
              <p className={E_TEKST}>{T.kanIkke[data.grund ?? ""] ?? T.fejl.fejl}</p>
              {data.grund === "ikke_aktiv" && (
                <Link href="/firma/abonnement" className={`${E_KNAP_SEKUNDAER} mt-4 w-full sm:w-auto`}>
                  {T.seAbonnement}
                </Link>
              )}
            </div>
          ) : !valgtUge ? (
            <p className={E_TEKST}>{T.vaelgFoerst}</p>
          ) : !start ? (
            <div>
              <p className="text-[19px] font-semibold text-tekst">
                {T.valgtUge(valgtUge.uge_nr, kortDato(valgtUge.uge_start), kortDato(soendag(valgtUge.uge_start)))}
              </p>
              <p className={E_TEKST_DAEMPET}>
                {valgtUge.status === "din_reservation" && aabenReserveret ? (
                  T.reservationPris(krFraOere(aabenReserveret.beloeb_oere))
                ) : (
                  <>
                    {T.prisEkskl(krFraOere(valgtUge.pris_ekskl_moms_oere))} · {T.prisInkl(krFraOere(valgtUge.pris_inkl_moms_oere))}
                    {valgtUge.rabat_procent > 0 && ` · ${T.rabatIUgen(valgtUge.rabat_procent)}`}
                  </>
                )}
              </p>
              <button
                type="button"
                onClick={() => koeb(valgtUge.uge_start)}
                disabled={henter}
                aria-busy={henter || undefined}
                className={`${E_KNAP_PRIMAER} mt-4 w-full sm:w-auto`}
              >
                {henter && <span className="btn-spinner" aria-hidden="true" />}
                {henter
                  ? T.starter
                  : T.bookKnap(
                      valgtUge.uge_nr,
                      krFraOere(
                        valgtUge.status === "din_reservation" && aabenReserveret
                          ? aabenReserveret.beloeb_oere
                          : valgtUge.pris_inkl_moms_oere,
                      ),
                    )}
              </button>
            </div>
          ) : (
            <div>
              <h3 className="text-[22px] leading-tight font-semibold text-tekst">{T.betalTitel(valgtUge.uge_nr)}</h3>
              {start.reserveretTil && <p className={`mt-1 ${E_TEKST}`}>{T.betalTekst(tidspunkt(start.reserveretTil))}</p>}
              <Elements
                key={start.clientSecret}
                stripe={hentStripe()}
                options={{ clientSecret: start.clientSecret, appearance: stripeUdseende, locale: "da" }}
              >
                <BetalForm
                  beloebOere={start.beloebOere}
                  onFejl={(t) => (t ? visFejl(t) : setFejl(null))}
                  onSender={setSender}
                  onGenstart={() => {
                    setStart(null);
                    router.refresh();
                  }}
                />
              </Elements>
              {bookingId && (
                <button
                  type="button"
                  onClick={() => annuller(bookingId)}
                  disabled={sender || annullerer}
                  aria-busy={annullerer || undefined}
                  className={`${E_KNAP_SEKUNDAER} mt-3 w-full sm:w-auto`}
                >
                  {annullerer && <span className="btn-spinner" aria-hidden="true" />}
                  {T.fortryd}
                </button>
              )}
              <p className={`mt-4 ${E_TEKST_DAEMPET}`}>{T.betalStripe}</p>
            </div>
          )}

          {fejl && (
            <p
              ref={fejlRef}
              tabIndex={-1}
              role="alert"
              className="mt-4 rounded-none border-2 border-fejl-kant bg-fejl-bg p-4 text-[18px] font-semibold text-fejl-tekst outline-none"
            >
              {fejl}
            </p>
          )}
          {besked && (
            <p role="status" className="mt-4 rounded-none border-2 border-succes-kant bg-succes-bg p-4 text-[18px] text-succes-tekst">
              {besked}
            </p>
          )}
        </div>
      </Kort>
    </>
  );
}

function BetalForm({
  beloebOere,
  onFejl,
  onSender,
  onGenstart,
}: {
  beloebOere: number;
  onFejl: (t: string | null) => void;
  onSender: (v: boolean) => void;
  onGenstart: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [sender, setSender] = useState(false);
  const klar = Boolean(stripe && elements);
  const returSti = "/firma/ugens-butik";

  function saetSender(v: boolean) {
    setSender(v);
    onSender(v);
  }

  async function betal(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || sender) return;
    saetSender(true);
    onFejl(null);
    try {
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: `${window.location.origin}${returSti}` },
      });
      // Kommer vi hertil, er betalingen ikke gennemført (ellers omdirigeres der).
      if (error?.code === "payment_intent_unexpected_state" && error.payment_intent?.status === "succeeded") {
        router.replace(`${returSti}?payment_intent=${encodeURIComponent(error.payment_intent.id)}`);
        router.refresh();
        return;
      }
      if (error?.code === "payment_intent_unexpected_state" && error.payment_intent?.status === "canceled") {
        onGenstart();
        return;
      }
      onFejl(error?.message ?? T.betalFejl);
    } finally {
      saetSender(false);
    }
  }

  return (
    <form onSubmit={betal} method="post" noValidate aria-busy={sender || undefined} className="mt-5">
      <PaymentElement
        options={{
          layout: { type: "accordion", defaultCollapsed: false, radios: "always", spacedAccordionItems: true },
          // Link (Stripes "gem mine oplysninger") vises aldrig (betalingsmetoder.ts).
          wallets: PAYMENT_ELEMENT_WALLETS,
        }}
      />
      <StripeIndlaesningsfejl />
      <button type="submit" disabled={!klar || sender} aria-busy={sender || undefined} className={`${E_KNAP_PRIMAER} mt-5 w-full sm:w-auto`}>
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        {T.betalKnap(krFraOere(beloebOere))}
      </button>
    </form>
  );
}
