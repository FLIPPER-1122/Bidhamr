"use client";

// Checkout for vinderen: vare, levering, betaling og prisoversigt på én side.
//
// - Leveringsvalget gemmes på serveren (gemLeveringsvalgAction), før
//   betalingen startes. Serveren retter betalingens fragt og total og afviser
//   betaling uden valg (startBetaling svarer kode "vaelg_levering").
// - Prisen, der vises, regnes kun ud fra serverens tal: betalingens total
//   minus dens fragt (bud + gebyr + evt. gammel BidHamr Beskyttelse) plus
//   auktionens låste fragtpris for den valgte levering. Beløbet på
//   "Betal"-knappen er altid PaymentIntentens.
// - Kun afhentning (auktionen tilbyder ikke forsendelse) kræver intet valg.
// - Fragt via Shipmondo: køberen vælger selv fragtfirma (DAO eller GLS -
//   checkout.transportoerer; PostNord kun med SHIPMONDO_POSTNORD_AKTIV=true,
//   Filip 20. okt. 2026). Med GLS skal sælgeren printe en label (vises på
//   kortet og under valget). Prisen er den samme for alle;
//   pakkeshoppen vælges hos det valgte firma (skiftes firmaet, skal der
//   vælges en ny pakkeshop).
// - Tilbyder sælgeren både forsendelse og afhentning, kan køberen vælge
//   "Afhent hos sælger – 0 kr." før betaling. Så er fragten 0, og BidHamr
//   Beskyttelse gælder ikke (ingen sag ved afhentning). Ny prismodel
//   (20261031010000): Beskyttelse er inkluderet i gebyret ved forsendelse
//   (privat) og har ingen særskilt pris. Gamle handler (prismodel 'gammel')
//   med tilkøbt Beskyttelse: beløbet trækkes fra ved afhentning og lægges på
//   igen ved skift tilbage. Serveren retter beløbet og annullerer en gammel
//   PaymentIntent (samme regler som ved prisskift).
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { gemLeveringsvalgAction } from "@/app/actions/fragt";
import { startBetaling, type KoeberBetalingsstatus } from "@/app/actions/betaling";
import { metodeTekst } from "@/lib/betaling/betalingsmetoder";
import type { Checkout } from "@/lib/fragt/handlinger";
import { transportoerNavn } from "@/lib/fragt/types";
import { kroner } from "@/lib/kroner";
import { erBeskyttet, erErhvervPrismodel, koebergebyrTekst } from "@/lib/betaling/beregn";
import { BIDPANEL } from "@/lib/tekster/beskyttelse";
import { FOUNDING_SELLER } from "@/lib/tekster/foundingSeller";
import { kanOptimeres } from "@/lib/billedUrl";
import { slaaPostnummerOp } from "@/lib/postnumre";
import { BETINGELSER_STI } from "@/lib/vilkaar";
import { FejlBoks } from "@/components/betaling/FejlBoks";
import Nedtaelling from "@/components/betaling/Nedtaelling";
import Ikon, { type IkonNavn } from "@/components/Ikon";
import type { ValgtPakkeshop } from "@/components/checkout/PakkeshopVaelger";
import { CHECKOUT_FORM } from "@/components/checkout/konstanter";

// Indlæses først, når de skal bruges (mindre JavaScript ved sidens start):
// pakkeshop-vinduet ved klik på "Vælg pakkeshop", Stripes Payment Element når
// betalingen er klar. Skelettet har samme højde som feltet nedenfor.
const hentVaelger = () => void import("@/components/checkout/PakkeshopVaelger");
const PakkeshopVaelger = dynamic(() => import("@/components/checkout/PakkeshopVaelger"), { ssr: false });
const CheckoutBetaling = dynamic(() => import("@/components/checkout/CheckoutBetaling"), {
  ssr: false,
  loading: () => <BetalingSkelet />,
});

function BetalingSkelet() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="h-12 animate-pulse rounded-xl bg-groen-lys" />
      <div className="h-12 animate-pulse rounded-xl bg-groen-lys" />
      <div className="h-12 animate-pulse rounded-xl bg-groen-lys" />
    </div>
  );
}

type Maade = "pakkeshop" | "doer" | "afhentning";
type Modtager = { navn: string; telefon: string; adresse: string; postnummer: string; by: string };
type FeltFejl = Partial<Record<"navn" | "telefon" | "adresse" | "postnummer" | "by" | "shop", string>>;

// Telefon fra serveren står som +4512345678 - vis de 8 cifre.
function visTelefon(t: string | null | undefined) {
  if (!t) return "";
  return /^\+45\d{8}$/.test(t) ? t.slice(3) : t;
}

function signatur(maade: Maade, transportoer: string | null, shopId: string | null, m: Modtager) {
  const ren = (s: string) => s.replace(/\s+/g, " ").trim();
  if (maade === "afhentning") return JSON.stringify([maade]);
  return JSON.stringify(
    maade === "doer"
      ? [maade, transportoer, ren(m.navn), ren(m.telefon).replace(/\s/g, ""), ren(m.adresse), ren(m.postnummer), ren(m.by)]
      : [maade, transportoer, shopId, ren(m.navn), ren(m.telefon).replace(/\s/g, "")],
  );
}

// Den gemte pakkeshop ("Husk ... min pakkeshop") - serveren har tjekket, at
// den findes hos sit eget fragtfirma (pakkeshopTransportoer).
function gemtPakkeshop(forslag: Checkout["forslag"]): ValgtPakkeshop | null {
  if (!forslag?.pakkeshopId || !forslag.pakkeshopPostnummer) return null;
  return {
    transportoer: forslag.pakkeshopTransportoer ?? null,
    id: forslag.pakkeshopId,
    navn: forslag.pakkeshopNavn ?? "Pakkeshop",
    adresse: forslag.pakkeshopAdresse ?? "",
    postnummer: forslag.pakkeshopPostnummer,
    by: forslag.pakkeshopBy ?? "",
    soegPostnummer: forslag.pakkeshopPostnummer,
    soegAdresse: forslag.pakkeshopAdresse ?? null,
  };
}

// Den gemte pakkeshop bruges kun hos netop sit eget fragtfirma.
function gemtPakkeshopHos(gemt: ValgtPakkeshop | null, harFirmavalg: boolean, t: string | null): ValgtPakkeshop | null {
  return gemt && (!harFirmavalg || (gemt.transportoer ?? null) === t) ? gemt : null;
}

// Hører den gemte pakkeshop til et andet (valgbart) fragtfirma end det valgte?
function gemtHosAndetFirma(
  gemt: ValgtPakkeshop | null,
  valgt: string | null,
  firmaKoder: string[],
): { firma: string; firmaNavn: string; navn: string } | null {
  const firma = gemt?.transportoer ?? null;
  if (!gemt || !firma || firma === valgt || !firmaKoder.includes(firma)) return null;
  return { firma, firmaNavn: transportoerNavn(firma) ?? firma, navn: gemt.navn };
}

function valider(maade: Maade, shop: ValgtPakkeshop | null, m: Modtager): FeltFejl {
  const f: FeltFejl = {};
  if (maade === "afhentning") return f;
  if (m.navn.trim().length < 2) f.navn = "Skriv dit fulde navn.";
  const tlf = m.telefon.replace(/[\s().-]/g, "");
  if (!/^(\d{8}|(\+|00)\d{8,14})$/.test(tlf)) f.telefon = "Skriv et gyldigt telefonnummer (8 cifre).";
  if (maade === "pakkeshop" && !shop) f.shop = "Vælg en pakkeshop.";
  if (maade === "doer") {
    if (m.adresse.trim().length < 3) f.adresse = "Skriv vejnavn og husnummer.";
    if (!slaaPostnummerOp(m.postnummer)) f.postnummer = "Skriv et gyldigt dansk postnummer.";
    if (!m.by.trim()) f.by = "Skriv byen.";
  }
  return f;
}

const fristFormat = new Intl.DateTimeFormat("da-DK", {
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Copenhagen",
});

const feltKlasse = (fejl: boolean) =>
  `h-11 w-full rounded-xl border bg-white px-4 text-[15px] text-tekst placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-groen/25 ${
    fejl ? "border-fejl-kant bg-fejl-bg/40" : "border-kant-staerk hover:border-[#BFBFBF]"
  }`;

export default function CheckoutSide({
  tradeId,
  vare,
  status,
  checkout,
  standardNavn,
  betalingsmetoder,
}: {
  tradeId: string;
  // erhverv: firmasalg - ingen chat med sælgeren.
  // saelgerHarAdresse: sælgeren har gemt en afhentningsadresse (kun ja/nej).
  vare: { titel: string; billede: string | null; saelgerNavn: string | null; erhverv?: boolean; saelgerHarAdresse?: boolean };
  status: KoeberBetalingsstatus;
  checkout: Checkout;
  standardNavn: string | null;
  // Metoderne, køberen kan betale med hos netop denne sælger (fra serveren:
  // sælgerens Stripe-konto); erstattes af PaymentIntentens, når den er lavet.
  betalingsmetoder: string[];
}) {
  const id = useId();
  const bet = checkout.betaling;
  // Kun afhentning: intet valg. Ellers kan afhentning være et af valgene.
  const kunAfhentning = checkout.kunAfhentning;
  // Adressen vises på handelssiden efter betaling, men kun hvis sælgeren har
  // gemt en. Ellers lover vi ikke en adresse.
  const afhentningsAdresseTekst = Boolean(vare.saelgerHarAdresse);
  const aftalAfhentning = vare.erhverv
    ? "Kontakt firmaet via oplysningerne på handelssiden."
    : "Aftal afhentningen med sælgeren i beskederne efter betalingen.";
  const afhentningMulig = checkout.afhentningMulig;
  const doerMulig = checkout.doerOere !== null && checkout.doerOere > 0;
  const kanSkifteMaade = Boolean(bet?.kanAendrePris) && !checkout.labelLavet;
  const kanSkifteShop = !checkout.labelLavet;
  const valgt = checkout.valgt;
  const forslag = checkout.forslag;
  // Fragtfirmaer, køberen kan vælge (tom = intet valg).
  const firmaer = checkout.transportoerer ?? [];
  const kendtFirma = (t: string | null | undefined) => (t && firmaer.some((f) => f.kode === t) ? t : null);
  // Et firma, der ikke kan vælges længere (fx PostNord, der er slået fra),
  // bevares kun, når labelen allerede er lavet - ellers vælger køberen et af
  // dem, der kan vælges nu.
  const startTransportoer =
    (checkout.labelLavet && firmaer.length > 0 && valgt?.maade !== "afhentning" ? valgt?.transportoer : null) ??
    kendtFirma(valgt?.maade !== "afhentning" ? valgt?.transportoer : null) ??
    kendtFirma(forslag?.transportoer) ??
    firmaer[0]?.kode ??
    null;

  // Den gemte pakkeshop ("Husk ... min pakkeshop") - serveren har tjekket, at
  // den findes hos sit eget fragtfirma (pakkeshopTransportoer). Den bruges
  // kun hos netop det fragtfirma.
  const gemtShop = gemtPakkeshop(forslag);
  const harFirmavalg = firmaer.length > 0;

  // ---------------------------------------------------------------- startværdier
  const startMaade: Maade =
    valgt?.maade === "afhentning" && !afhentningMulig
      ? "pakkeshop"
      : (valgt?.maade ?? (forslag?.maade === "doer" && doerMulig && kanSkifteMaade ? "doer" : "pakkeshop"));
  const startShop: ValgtPakkeshop | null =
    valgt?.maade === "pakkeshop" &&
    valgt.pakkeshopId &&
    (firmaer.length === 0 || (valgt.transportoer ?? null) === startTransportoer)
      ? {
          transportoer: valgt.transportoer ?? null,
          id: valgt.pakkeshopId,
          navn: valgt.pakkeshopNavn ?? "Pakkeshop",
          adresse: valgt.pakkeshopAdresse ?? "",
          postnummer: valgt.pakkeshopPostnummer ?? "",
          by: valgt.pakkeshopBy ?? "",
          soegPostnummer: valgt.pakkeshopPostnummer ?? "",
          soegAdresse: valgt.pakkeshopAdresse ?? null,
        }
      : gemtPakkeshopHos(gemtShop, harFirmavalg, startTransportoer);
  // Ved afhentning er der ingen modtager på valget - forslaget forudfylder.
  const kilde = (valgt && valgt.maade !== "afhentning" ? valgt.modtager : null) ?? forslag?.modtager ?? null;
  // Uden adresse på valget/forslaget forudfyldes den gemte adresse fra Min
  // adresse (bruger_adresser, 20261102340000) - samlet, så vej, postnummer
  // og by altid hører sammen.
  const kildeHarAdresse = Boolean(kilde?.adresse && kilde?.postnummer);
  const gemtAdresse = checkout.minAdresse;
  const startModtager: Modtager = {
    navn: kilde?.navn ?? standardNavn ?? "",
    telefon: visTelefon(kilde?.telefon),
    adresse: (kildeHarAdresse ? kilde?.adresse : gemtAdresse?.adresse) ?? "",
    postnummer: (kildeHarAdresse ? kilde?.postnummer : gemtAdresse?.postnummer) ?? "",
    by: (kildeHarAdresse ? kilde?.by : gemtAdresse?.by) ?? "",
  };

  const [maade, setMaade] = useState<Maade>(startMaade);
  const [transportoer, setTransportoer] = useState<string | null>(startTransportoer);
  const [shop, setShop] = useState<ValgtPakkeshop | null>(startShop);
  const [modtager, setModtager] = useState<Modtager>(startModtager);
  const [gemForslag, setGemForslag] = useState(true);
  // Signaturen af det valg, der er gemt på serveren (null = intet gemt).
  const [gemt, setGemt] = useState<string | null>(
    valgt ? signatur(valgt.maade, valgt.transportoer ?? null, valgt.pakkeshopId, startModtager) : null,
  );
  const [feltFejl, setFeltFejl] = useState<FeltFejl>({});
  const [leveringFejl, setLeveringFejl] = useState<string | null>(null);
  const [vaelgerAaben, setVaelgerAaben] = useState(false);

  const [serverFragt, setServerFragt] = useState(bet?.fragt_oere ?? status.fragtOere);
  const [serverTotal, setServerTotal] = useState(bet?.total_oere ?? status.totalOere);
  const [serverBesk, setServerBesk] = useState(bet?.beskyttelse_oere ?? status.beskyttelseOere);
  // BidHamr Beskyttelse, hvis der vælges forsendelse (0 kr. ved afhentning).
  const [beskForsendelse, setBeskForsendelse] = useState(checkout.beskyttelseVedForsendelseOere);

  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [piTotal, setPiTotal] = useState<number | null>(null);
  const [kundeSession, setKundeSession] = useState<string | null>(null);
  const [metoder, setMetoder] = useState<string[]>(betalingsmetoder);
  const hentetKl = useRef(0);
  const [stripeKlar, setStripeKlar] = useState(false);
  const [arbejder, setArbejder] = useState(false);
  const [sender, setSender] = useState(false);
  const [betalFejl, setBetalFejl] = useState<string | null>(null);
  const [alleredeBetalt, setAlleredeBetalt] = useState<string | null>(null);

  const leveringRef = useRef<HTMLHeadingElement>(null);
  const betalingRef = useRef<HTMLHeadingElement>(null);
  const fejlRef = useRef<HTMLDivElement>(null);
  const knapRef = useRef<HTMLDivElement>(null);
  const [knapSynlig, setKnapSynlig] = useState(false);
  const laas = useRef(false);

  const aktuelSignatur = signatur(maade, transportoer, maade === "pakkeshop" ? (shop?.id ?? null) : null, modtager);
  const valgtFirma = firmaer.find((f) => f.kode === transportoer) ?? null;
  // Den gemte pakkeshop hører til et andet fragtfirma end det valgte.
  const gemtHosAndet = kanSkifteShop
    ? gemtHosAndetFirma(gemtPakkeshop(forslag), transportoer, firmaer.map((f) => f.kode))
    : null;
  const firmaNavn = valgtFirma?.navn ?? transportoerNavn(transportoer) ?? "DAO";

  // Nyt fragtfirma: pakkeshoppen skal vælges hos det nye firma - har køberen
  // en gemt pakkeshop hos netop det firma, forudfyldes den.
  function vaelgFirma(t: string) {
    setTransportoer(t);
    if (!shop || (shop.transportoer ?? null) !== t) setShop(gemtPakkeshopHos(gemtPakkeshop(forslag), harFirmavalg, t));
    setFeltFejl((f) => ({ ...f, shop: undefined }));
  }
  const leveringGemt = kunAfhentning || gemt === aktuelSignatur;
  const afhentningValgt = kunAfhentning || maade === "afhentning";
  const betalingKlar = Boolean(clientSecret) && leveringGemt;

  // Kan der overhovedet betales nu?
  const lukket =
    status.venterPaaSaelgerkonto || status.fristOverskredet || status.status !== "afventer" || !bet || Boolean(alleredeBetalt);

  // ---------------------------------------------------------------- priser
  const grundOere = serverTotal - serverFragt - serverBesk; // bud + købergebyr
  // Når betalingen er klar, vises serverens tal, så linjerne summerer til totalen.
  const fragtVist = afhentningValgt
    ? 0
    : betalingKlar
      ? serverFragt
    : maade === "doer"
      ? (checkout.doerOere ?? serverFragt)
      : (checkout.pakkeshopOere ?? serverFragt);
  const beskVist = kunAfhentning || betalingKlar ? serverBesk : maade === "afhentning" ? 0 : beskForsendelse;
  const totalVist = betalingKlar && piTotal !== null ? piTotal : grundOere + fragtVist + beskVist;
  // Gammel handel: køberen har tilkøbt BidHamr Beskyttelse, men har valgt
  // afhentning - den gælder ikke og er trukket fra.
  const gammelModel = status.prismodel === "gammel";
  const beskFjernet = gammelModel && maade === "afhentning" && !kunAfhentning && beskForsendelse > 0;
  // Ny prismodel: BidHamr Beskyttelse er med i gebyret, når varen sendes (privat).
  const erhvervHandel = vare.erhverv || erErhvervPrismodel(status.prismodel);
  const beskyttetVist = gammelModel ? beskVist > 0 : erBeskyttet(erhvervHandel, !afhentningValgt);
  const gebyrNavn = koebergebyrTekst(status.prismodel, beskyttetVist);

  // ---------------------------------------------------------------- handlinger
  const visBetalFejl = useCallback((tekst: string | null, betalt?: boolean) => {
    if (betalt && tekst) setAlleredeBetalt(tekst);
    else setBetalFejl(tekst);
  }, []);

  const hentBetaling = useCallback(async () => {
    const svar = await startBetaling(tradeId);
    if ("fejl" in svar) {
      if (svar.betalt) setAlleredeBetalt(svar.fejl);
      else if (svar.kode === "vaelg_levering") {
        setGemt(null);
        setLeveringFejl(svar.fejl);
        leveringRef.current?.focus();
      } else if (svar.kode === "adresse_mangler") {
        // Adressen mangler: siden viser adresseformularen (betal/page.tsx).
        setBetalFejl(svar.fejl);
        window.location.reload();
      } else setBetalFejl(svar.fejl);
      return false;
    }
    setClientSecret(svar.clientSecret);
    setPiTotal(svar.totalOere);
    // Gemt kort: Stripe-kundesession, så Payment Element viser kortet forvalgt.
    setKundeSession(svar.customerSessionClientSecret || null);
    if (svar.betalingsmetoder?.length) setMetoder(svar.betalingsmetoder);
    hentetKl.current = Date.now();
    return true;
  }, [tradeId]);

  // Er leveringen allerede valgt (eller en afhentning), vises betalingen med det samme.
  const autoStartet = useRef(false);
  useEffect(() => {
    if (autoStartet.current || lukket || !leveringGemt) return;
    autoStartet.current = true;
    setArbejder(true);
    void hentBetaling().finally(() => setArbejder(false));
  }, [lukket, leveringGemt, hentBetaling]);

  // Stripes kundesession (gemt kort) lever 30 min: har siden stået længe,
  // hentes betalingen igen, når fanen bliver aktiv (samme PaymentIntent).
  useEffect(() => {
    function tjek() {
      if (document.visibilityState !== "visible" || laas.current || sender) return;
      if (!hentetKl.current || Date.now() - hentetKl.current < 25 * 60_000) return;
      hentetKl.current = Date.now();
      void hentBetaling();
    }
    document.addEventListener("visibilitychange", tjek);
    return () => {
      document.removeEventListener("visibilitychange", tjek);
    };
  }, [hentBetaling, sender]);

  // Mobil: den faste bund-bjælke skjules, når knappen i prisoversigten ses.
  useEffect(() => {
    const el = knapRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setKnapSynlig(e.isIntersecting), { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  async function fortsaet() {
    if (laas.current || lukket) return;
    setBetalFejl(null);
    setLeveringFejl(null);
    if (!kunAfhentning) {
      const f = valider(maade, shop, modtager);
      setFeltFejl(f);
      if (Object.keys(f).length > 0) {
        setLeveringFejl("Udfyld de markerede felter under Levering.");
        requestAnimationFrame(() => fejlRef.current?.focus());
        return;
      }
    }
    laas.current = true;
    setArbejder(true);
    try {
      if (!leveringGemt) {
        const r = await gemLeveringsvalgAction(tradeId, maade === "afhentning" ? { maade } : {
          maade,
          transportoer: transportoer ?? undefined,
          pakkeshopId: maade === "pakkeshop" ? shop?.id : undefined,
          pakkeshopPostnummer: maade === "pakkeshop" ? shop?.soegPostnummer || shop?.postnummer : undefined,
          pakkeshopAdresse: maade === "pakkeshop" ? shop?.soegAdresse : undefined,
          modtager: {
            navn: modtager.navn,
            telefon: modtager.telefon,
            ...(maade === "doer"
              ? { adresse: modtager.adresse, postnummer: modtager.postnummer, by: modtager.by }
              : {}),
          },
          gemForslag,
        });
        if ("fejl" in r) {
          setLeveringFejl(r.fejl);
          requestAnimationFrame(() => fejlRef.current?.focus());
          return;
        }
        setServerFragt(r.fragtOere);
        setServerTotal(r.totalOere);
        setServerBesk(r.beskyttelseOere);
        if (!r.afhentning) setBeskForsendelse(r.beskyttelseOere);
        setGemt(aktuelSignatur);
        // Beløbet kan være ændret: den gamle PaymentIntent er annulleret.
        setClientSecret(null);
        setPiTotal(null);
      }
      if (await hentBetaling()) {
        requestAnimationFrame(() => {
          betalingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
          betalingRef.current?.focus({ preventScroll: true });
        });
      }
    } catch {
      setBetalFejl("Noget gik galt. Prøv igen om lidt.");
    } finally {
      laas.current = false;
      setArbejder(false);
    }
  }

  function saetModtager<K extends keyof Modtager>(k: K, v: string) {
    setModtager((m) => {
      const ny = { ...m, [k]: v };
      // Byen udfyldes fra postnummeret.
      if (k === "postnummer") {
        const opslag = slaaPostnummerOp(v);
        if (opslag && (!m.by || slaaPostnummerOp(m.postnummer)?.by === m.by)) ny.by = opslag.by;
      }
      return ny;
    });
    if (feltFejl[k]) setFeltFejl((f) => ({ ...f, [k]: undefined }));
  }

  // ---------------------------------------------------------------- knap
  const knapTekst = betalingKlar ? `Betal ${kroner(totalVist)}` : "Fortsæt til betaling";
  const knapDeaktiveret = lukket || arbejder || sender || (betalingKlar && !stripeKlar);
  const travl = arbejder || sender;

  function knap(stor = false) {
    return betalingKlar ? (
      <button
        type="submit"
        form={CHECKOUT_FORM}
        disabled={knapDeaktiveret}
        aria-busy={travl || undefined}
        className={`btn btn-primaer w-full ${stor ? "btn-stor" : ""}`}
      >
        {travl && <span className="btn-spinner" aria-hidden="true" />}
        {knapTekst}
      </button>
    ) : (
      <button
        type="button"
        onClick={() => void fortsaet()}
        disabled={knapDeaktiveret}
        aria-busy={travl || undefined}
        className={`btn btn-primaer w-full ${stor ? "btn-stor" : ""}`}
      >
        {travl && <span className="btn-spinner" aria-hidden="true" />}
        {knapTekst}
      </button>
    );
  }

  const handelSti = `/mine-handler/${tradeId}`;
  const fragtNavn = afhentningValgt
    ? "Afhentning hos sælger"
    : `Fragt – ${firmaer.length > 0 ? `${firmaNavn}, ` : ""}${maade === "doer" ? "levering hjem" : "pakkeshop"}`;

  // ---------------------------------------------------------------- visning
  return (
    <main className="flex-1 px-4 pt-4 pb-28 sm:px-6 lg:px-8 lg:pt-6 lg:pb-10">
      <div className="mx-auto max-w-[1120px]">
        <Link
          href="/mine-handler"
          className="-mb-1 inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-tekst-daempet hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          <Ikon navn="venstre" className="h-4 w-4" />
          Tilbage til mine handler
        </Link>
        <h1 className="mt-2 text-[26px] leading-tight lg:text-[32px]">Betal for din vare</h1>

        {/* Frist */}
        <div className="mt-4">
          {status.venterPaaSaelgerkonto ? (
            <p className="rounded-xl border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
              Betalingen åbner, når sælgerens konto er godkendt hos vores betalingspartner Stripe. Du får
              besked, så snart du kan betale – derefter har du 48 timer. Bliver kontoen ikke godkendt inden for
              7 dage, bliver handlen annulleret, og du bliver ikke trukket noget.
            </p>
          ) : status.fristOverskredet ? (
            <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
              Fristen for at betale er gået, så du kan ikke betale længere. Kontakt os, hvis du mener, det er en fejl.
            </p>
          ) : (
            <p className="flex items-start gap-3 rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
              <Ikon navn="ur" className="mt-px h-5 w-5 shrink-0" />
              <span>
                Betal senest <span className="font-semibold">{fristFormat.format(new Date(status.betalSenest))}</span>
                <span className="mx-1.5" aria-hidden="true">
                  ·
                </span>
                <span className="font-semibold">
                  <Nedtaelling til={status.betalSenest} />
                </span>
                <span className="block text-[13px]">
                  Betaler du ikke inden fristen, annulleres handlen, og du kan få en advarsel.
                </span>
              </span>
            </p>
          )}
        </div>

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-8">
          <div className="min-w-0 space-y-6">
            {/* Varen */}
            <section aria-label="Varen" className="rounded-none border border-kant bg-white p-4 sm:p-5">
              <div className="flex items-center gap-4">
                <div className="relative grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-lg bg-skelet">
                  {vare.billede ? (
                    <Image
                      src={vare.billede}
                      alt=""
                      fill
                      sizes="80px"
                      unoptimized={!kanOptimeres(vare.billede)}
                      className="object-cover"
                    />
                  ) : (
                    <Ikon navn="pakke" className="h-7 w-7 text-tekst-svag" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[17px] leading-snug font-semibold break-words text-tekst">{vare.titel}</p>
                  <p className="mt-1 text-sm text-tekst-daempet">
                    Dit vinderbud: <span className="font-bold text-tekst tabular-nums">{kroner(status.budOere)}</span>
                  </p>
                  {vare.saelgerNavn && <p className="text-[13px] text-tekst-svag">Sælger: {vare.saelgerNavn}</p>}
                </div>
              </div>
              <Link
                href={`${handelSti}?vis=handel`}
                className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
              >
                <Ikon navn="besked" className="h-[18px] w-[18px]" />
                Se handlen og skriv til sælgeren
              </Link>
            </section>

            {/* Levering */}
            <section aria-labelledby={`${id}-levering`} className="rounded-none border border-kant bg-white p-4 sm:p-6">
              <h2 id={`${id}-levering`} ref={leveringRef} tabIndex={-1} className="text-[20px] leading-tight outline-none lg:text-[22px]">
                Levering
              </h2>

              {kunAfhentning ? (
                <div className="mt-4">
                  <LeveringKort
                    ikon="bruger"
                    titel="Afhentning hos sælger"
                    tekst="Du henter varen hos sælgeren og viser din afhentningskode, når du får varen."
                    pris="0 kr"
                    valgt
                  />
                  <p className="mt-3 text-sm text-tekst-daempet">
                    {afhentningsAdresseTekst
                      ? "Varen kan kun hentes hos sælgeren. Når du har betalt, ser du adressen og din afhentningskode på handelssiden. Du har 7 dage til at hente varen."
                      : `Varen kan kun hentes hos sælgeren. Når du har betalt, ser du din afhentningskode på handelssiden. ${aftalAfhentning} Du har 7 dage til at hente varen.`}
                  </p>
                </div>
              ) : (
                <>
                  <fieldset className="mt-4 min-w-0" disabled={travl}>
                    <legend className="mb-2 text-sm font-medium text-tekst">Leveringsmulighed</legend>
                    <div className="grid gap-3">
                      {(kanSkifteMaade || maade === "pakkeshop") && (
                        <LeveringKort
                          navn={`${id}-maade`}
                          ikon="butik"
                          titel="Pakkeshop"
                          tekst={firmaer.length > 0 ? "Du henter pakken i en pakkeshop, du selv vælger." : "Du henter pakken i en DAO-pakkeshop, du selv vælger."}
                          pris={kroner(checkout.pakkeshopOere ?? serverFragt)}
                          valgt={maade === "pakkeshop"}
                          onVaelg={() => setMaade("pakkeshop")}
                        />
                      )}
                      {doerMulig && (kanSkifteMaade || maade === "doer") && (
                        <LeveringKort
                          navn={`${id}-maade`}
                          ikon="hjem"
                          titel="Levering hjem"
                          tekst={firmaer.length > 0 ? "Fragtfirmaet bringer pakken hjem til din dør." : "DAO bringer pakken hjem til din dør."}
                          pris={kroner(checkout.doerOere!)}
                          valgt={maade === "doer"}
                          onVaelg={() => setMaade("doer")}
                        />
                      )}
                      {afhentningMulig && (kanSkifteMaade || maade === "afhentning") && (
                        <LeveringKort
                          navn={`${id}-maade`}
                          ikon="bruger"
                          titel="Afhent hos sælger"
                          tekst="Du henter varen hos sælgeren og viser din afhentningskode."
                          pris={kroner(0)}
                          valgt={maade === "afhentning"}
                          onVaelg={() => setMaade("afhentning")}
                        />
                      )}
                    </div>
                    {!kanSkifteMaade && (
                      <p className="mt-2 text-[13px] text-tekst-daempet">
                        Leveringsmåden kan ikke ændres længere{kanSkifteShop && maade === "pakkeshop" ? ", men du kan skifte pakkeshop" : ""}.
                      </p>
                    )}
                    {!doerMulig && kanSkifteMaade && (
                      <p className="mt-2 text-[13px] text-tekst-daempet">
                        Pakken er for stor til levering hjem. Den kan kun sendes til en pakkeshop.
                      </p>
                    )}
                  </fieldset>

                  {maade !== "afhentning" && firmaer.length > 0 && (
                    <fieldset className="mt-5 min-w-0" disabled={travl || !kanSkifteShop}>
                      <legend className="mb-2 text-sm font-medium text-tekst">Fragtfirma</legend>
                      <div className={`grid gap-3 ${firmaer.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
                        {firmaer.map((f) => (
                          <FirmaKort
                            key={f.kode}
                            navn={`${id}-firma`}
                            firma={f.navn}
                            leveringstid={f.leveringstid}
                            labelfri={f.labelfri}
                            pris={kroner(
                              maade === "doer" ? (checkout.doerOere ?? serverFragt) : (checkout.pakkeshopOere ?? serverFragt),
                            )}
                            valgt={transportoer === f.kode}
                            onVaelg={() => vaelgFirma(f.kode)}
                          />
                        ))}
                      </div>
                      {valgtFirma && !valgtFirma.labelfri && (
                        <p className="mt-3 rounded-xl bg-groen-lys px-4 py-3 text-sm text-tekst-daempet">
                          Med {valgtFirma.navn} skal sælgeren printe en label og sætte den på pakken. Det kan tage lidt
                          længere, før pakken bliver sendt.
                        </p>
                      )}
                      <p className="mt-2 text-[13px] text-tekst-daempet">
                        Prisen er den samme hos alle fragtfirmaer.
                        {!kanSkifteShop && " Fragtfirmaet kan ikke ændres, når sælgeren har lavet fragtlabelen."}
                      </p>
                    </fieldset>
                  )}

                  {maade === "afhentning" && (
                    <div className="mt-5 space-y-2 rounded-xl bg-groen-lys p-4 text-sm text-tekst-daempet">
                      <p>
                        {afhentningsAdresseTekst
                          ? "Når du har betalt, ser du sælgerens adresse og din afhentningskode på handelssiden. Du har 7 dage til at hente varen. "
                          : "Når du har betalt, ser du din afhentningskode på handelssiden. Du har 7 dage til at hente varen. "}
                        {vare.erhverv
                          ? "Kontakt firmaet via oplysningerne på handelssiden."
                          : vare.saelgerHarAdresse
                            ? "Aftal tidspunktet med sælgeren i chatten."
                            : aftalAfhentning}
                      </p>
                      {beskFjernet ? (
                        <p>
                          BidHamr Beskyttelse gælder ikke ved afhentning, så den er trukket fra prisen. Du ser varen,
                          før du viser koden.
                        </p>
                      ) : (
                        !gammelModel &&
                        !erhvervHandel && (
                          <p>BidHamr Beskyttelse gælder kun, når varen sendes. Du ser varen, før du viser koden.</p>
                        )
                      )}
                    </div>
                  )}

                  {maade === "pakkeshop" && (
                    <div className="mt-5">
                      <p className="mb-1.5 text-sm font-medium text-tekst">
                        {firmaer.length > 0 ? `Pakkeshop hos ${firmaNavn}` : "Pakkeshop"}
                      </p>
                      <div
                        className={`flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center ${
                          feltFejl.shop ? "border-fejl-kant bg-fejl-bg/40" : "border-kant bg-groen-lys"
                        }`}
                      >
                        <Ikon navn="lokation" className="hidden h-6 w-6 shrink-0 text-groen-mork sm:block" />
                        <div className="min-w-0 flex-1" id={`${id}-shop`}>
                          {shop ? (
                            <>
                              <p className="font-semibold text-tekst">{shop.navn}</p>
                              <p className="text-sm text-tekst-daempet">
                                {shop.adresse}
                                {shop.postnummer && `, ${shop.postnummer} ${shop.by}`}
                              </p>
                            </>
                          ) : gemtHosAndet ? (
                            // Den gemte pakkeshop hører til et andet fragtfirma.
                            <>
                              <p className="text-sm text-tekst-daempet">
                                Din gemte pakkeshop er hos {gemtHosAndet.firmaNavn}:{" "}
                                <span className="font-medium text-tekst">{gemtHosAndet.navn}</span>.
                              </p>
                              <button
                                type="button"
                                onClick={() => vaelgFirma(gemtHosAndet.firma)}
                                disabled={travl}
                                className="mt-1 inline-flex min-h-11 items-center rounded-md text-sm font-semibold text-groen underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
                              >
                                Brug den ({gemtHosAndet.firmaNavn})
                              </button>
                            </>
                          ) : (
                            <p className="text-sm text-tekst-daempet">Du har ikke valgt en pakkeshop endnu.</p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setVaelgerAaben(true)}
                          // Hent vinduets kode, så snart knappen er i spil.
                          onPointerEnter={hentVaelger}
                          onFocus={hentVaelger}
                          disabled={!kanSkifteShop || travl}
                          aria-haspopup="dialog"
                          aria-describedby={`${id}-shop`}
                          className={`btn shrink-0 ${shop ? "btn-sekundaer" : "btn-primaer"}`}
                        >
                          {shop ? "Skift pakkeshop" : "Vælg pakkeshop"}
                        </button>
                      </div>
                      {feltFejl.shop && <FeltFejlTekst id={`${id}-shop-fejl`}>{feltFejl.shop}</FeltFejlTekst>}
                    </div>
                  )}

                  {/* Modtager */}
                  {maade !== "afhentning" && (
                  <fieldset className="mt-5 min-w-0" disabled={travl}>
                    <legend className="mb-2 text-sm font-medium text-tekst">
                      {maade === "doer" ? "Leveringsadresse" : "Modtager"}
                    </legend>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Felt id={`${id}-navn`} label="Fulde navn" fejl={feltFejl.navn} className="sm:col-span-2">
                        <input
                          id={`${id}-navn`}
                          value={modtager.navn}
                          onChange={(e) => saetModtager("navn", e.target.value)}
                          autoComplete="name"
                          maxLength={100}
                          aria-invalid={feltFejl.navn ? true : undefined}
                          aria-describedby={feltFejl.navn ? `${id}-navn-fejl` : undefined}
                          className={feltKlasse(!!feltFejl.navn)}
                        />
                      </Felt>
                      {maade === "doer" && (
                        <>
                          <Felt id={`${id}-adresse`} label="Adresse" fejl={feltFejl.adresse} className="sm:col-span-2">
                            <input
                              id={`${id}-adresse`}
                              value={modtager.adresse}
                              onChange={(e) => saetModtager("adresse", e.target.value)}
                              autoComplete="street-address"
                              maxLength={200}
                              placeholder="Vejnavn og husnummer"
                              aria-invalid={feltFejl.adresse ? true : undefined}
                              aria-describedby={feltFejl.adresse ? `${id}-adresse-fejl` : undefined}
                              className={feltKlasse(!!feltFejl.adresse)}
                            />
                          </Felt>
                          <Felt id={`${id}-postnummer`} label="Postnummer" fejl={feltFejl.postnummer}>
                            <input
                              id={`${id}-postnummer`}
                              value={modtager.postnummer}
                              onChange={(e) => saetModtager("postnummer", e.target.value.replace(/\D/g, "").slice(0, 4))}
                              autoComplete="postal-code"
                              inputMode="numeric"
                              aria-invalid={feltFejl.postnummer ? true : undefined}
                              aria-describedby={feltFejl.postnummer ? `${id}-postnummer-fejl` : undefined}
                              className={feltKlasse(!!feltFejl.postnummer)}
                            />
                          </Felt>
                          <Felt id={`${id}-by`} label="By" fejl={feltFejl.by}>
                            <input
                              id={`${id}-by`}
                              value={modtager.by}
                              onChange={(e) => saetModtager("by", e.target.value)}
                              autoComplete="address-level2"
                              maxLength={80}
                              aria-invalid={feltFejl.by ? true : undefined}
                              aria-describedby={feltFejl.by ? `${id}-by-fejl` : undefined}
                              className={feltKlasse(!!feltFejl.by)}
                            />
                          </Felt>
                        </>
                      )}
                      <Felt
                        id={`${id}-telefon`}
                        label="Mobilnummer"
                        fejl={feltFejl.telefon}
                        hjaelp={`${firmaNavn} bruger nummeret til at give dig besked om pakken.`}
                        className="sm:col-span-2"
                      >
                        <input
                          id={`${id}-telefon`}
                          type="tel"
                          value={modtager.telefon}
                          onChange={(e) => saetModtager("telefon", e.target.value)}
                          autoComplete="tel"
                          inputMode="tel"
                          maxLength={20}
                          aria-invalid={feltFejl.telefon ? true : undefined}
                          aria-describedby={`${id}-telefon-hjaelp${feltFejl.telefon ? ` ${id}-telefon-fejl` : ""}`}
                          className={`${feltKlasse(!!feltFejl.telefon)} sm:max-w-[260px]`}
                        />
                      </Felt>
                    </div>
                    <label className="mt-4 flex min-h-11 cursor-pointer items-center gap-3 text-sm text-tekst">
                      <input
                        type="checkbox"
                        checked={gemForslag}
                        onChange={(e) => setGemForslag(e.target.checked)}
                        className="h-5 w-5 shrink-0 rounded-none accent-groen"
                      />
                      Husk mine oplysninger og min pakkeshop til næste køb
                    </label>
                  </fieldset>
                  )}
                </>
              )}

              {leveringFejl && (
                <div ref={fejlRef} tabIndex={-1} className="mt-4 outline-none">
                  <FejlBoks tekst={leveringFejl} />
                  {/Genindlæs/.test(leveringFejl) && (
                    <button type="button" onClick={() => window.location.reload()} className="btn btn-sekundaer mt-3">
                      Genindlæs siden
                    </button>
                  )}
                </div>
              )}
            </section>

            {/* Betaling */}
            <section aria-labelledby={`${id}-betaling`} className="rounded-none border border-kant bg-white p-4 sm:p-6">
              <h2 id={`${id}-betaling`} ref={betalingRef} tabIndex={-1} className="scroll-mt-6 text-[20px] leading-tight outline-none lg:text-[22px]">
                Betaling
              </h2>
              <div className="mt-4 space-y-4">
                {alleredeBetalt ? (
                  <div role="status" className="rounded-xl border border-info-kant bg-info-bg p-4 text-sm text-info-tekst">
                    {/behandles/i.test(alleredeBetalt) ? (
                      <p className="font-semibold">Betalingen behandles. Vi giver dig besked, når den er gennemført.</p>
                    ) : (
                      <>
                        <p className="font-semibold">{alleredeBetalt}</p>
                        <p className="mt-1">Betalingen er gennemført, måske i en anden fane. Se status på handelssiden.</p>
                      </>
                    )}
                    <a href={`${handelSti}?vis=handel`} className="btn btn-sekundaer mt-3">
                      Gå til handlen
                    </a>
                  </div>
                ) : status.status === "behandles" ? (
                  <div role="status" className="rounded-xl border border-info-kant bg-info-bg p-4 text-sm text-info-tekst">
                    <p className="font-semibold">Betalingen behandles. Vi giver dig besked, når den er gennemført.</p>
                    <p className="mt-1">Det tager normalt kun et øjeblik.</p>
                  </div>
                ) : lukket ? (
                  <p className="text-sm text-tekst-daempet">Betalingen er ikke åben lige nu.</p>
                ) : (
                  <>
                    {status.sidsteFejl && !betalFejl && (
                      <p className="rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
                        Betalingen gik ikke igennem. Prøv igen, eller vælg en anden betalingsmetode.
                      </p>
                    )}
                    {betalingKlar && clientSecret ? (
                      <CheckoutBetaling
                        clientSecret={clientSecret}
                        customerSessionClientSecret={kundeSession}
                        handelId={tradeId}
                        sender={sender}
                        onSender={setSender}
                        onKlar={setStripeKlar}
                        onFejl={visBetalFejl}
                        onGenstart={() => {
                          setClientSecret(null);
                          setPiTotal(null);
                          setBetalFejl("Betalingen blev ændret i mellemtiden. Vi har gjort den klar igen – prøv at betale igen.");
                          void hentBetaling();
                        }}
                      />
                    ) : arbejder && leveringGemt ? (
                      <BetalingSkelet />
                    ) : (
                      <div className="flex items-start gap-3 rounded-xl border border-dashed border-kant-staerk px-4 py-4 text-sm text-tekst-daempet">
                        <Ikon navn="kort" className="mt-px h-5 w-5 shrink-0 text-groen" />
                        <span>
                          {gemt && !leveringGemt
                            ? "Du har ændret leveringen. Tryk “Fortsæt til betaling” for at se den nye pris og betale."
                            : `Vælg levering, og tryk “Fortsæt til betaling”. Du kan betale med ${metodeTekst(metoder)}.`}
                        </span>
                      </div>
                    )}
                    {betalFejl && <FejlBoks tekst={betalFejl} />}
                  </>
                )}
              </div>
            </section>
          </div>

          {/* Prisoversigt */}
          <aside aria-labelledby={`${id}-pris`} className="lg:sticky lg:top-6">
            <div className="rounded-none border border-kant bg-white p-4 sm:p-6">
              <h2 id={`${id}-pris`} className="text-[20px] leading-tight lg:text-[22px]">
                Prisoversigt
              </h2>
              <dl className="mt-4 space-y-2 text-sm" aria-live="polite">
                <Linje navn="Vinderbud" vaerdi={kroner(status.budOere)} />
                <Linje navn={gebyrNavn} vaerdi={kroner(status.koebergebyrOere)} />
                <Linje navn={fragtNavn} vaerdi={kroner(fragtVist)} />
                {gammelModel && beskVist > 0 && <Linje navn="BidHamr Beskyttelse" vaerdi={kroner(beskVist)} />}
                <div className="flex items-baseline justify-between gap-4 border-t border-kant pt-3">
                  <dt className="text-[15px] font-semibold text-tekst">Samlet beløb</dt>
                  <dd className="text-lg font-bold text-tekst tabular-nums">{kroner(totalVist)}</dd>
                </div>
              </dl>
              {status.founderRabatPct > 0 && (
                <p className="mt-2 text-[13px] text-tekst-svag">{FOUNDING_SELLER.gebyrNote(status.founderRabatPct)}</p>
              )}

              <div ref={knapRef} className="mt-5">
                {knap()}
              </div>

              {betalingKlar && (
                <p className="mt-3 text-center text-[13px] text-tekst-daempet">
                  Ved at betale accepterer du BidHamrs{" "}
                  <a
                    href={BETINGELSER_STI}
                    target="_blank"
                    rel="noopener"
                    className="font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
                  >
                    brugerbetingelser
                    <span className="sr-only"> (åbner i et nyt vindue)</span>
                  </a>
                  .
                </p>
              )}

              <div className="mt-5 rounded-xl bg-groen-lys p-4 text-sm text-groen-mork">
                <p className="flex items-center gap-2 font-semibold">
                  <Ikon navn="skjold" className="h-5 w-5 shrink-0" />
                  {afhentningValgt
                    ? "Sælgeren får først pengene, når du har hentet varen"
                    : "Sælgeren får først pengene, når du har fået varen"}
                </p>
                <p className="mt-1.5 text-tekst-daempet">
                  {afhentningValgt
                    ? "Pengene udbetales, når du har set varen og vist sælgeren din afhentningskode. Vis kun koden, hvis varen er, som den skal være."
                    : `Pengene udbetales, når du har godkendt varen, eller når fristen for at oprette en sag er gået. ${
                        beskyttetVist
                          ? gammelModel
                            ? "Du har valgt BidHamr Beskyttelse, så vi hjælper dig, hvis varen går i stykker under forsendelsen."
                            : BIDPANEL.beskyttelseInkluderet
                          : "Kommer pakken ikke frem, hjælper vi dig."
                      }`}{" "}
                  <Link
                    href="/bidhamr-beskyttelse"
                    className="font-medium text-groen underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
                  >
                    Læs mere
                  </Link>
                </p>
              </div>

              <p className="mt-4 flex items-center justify-center gap-2 text-[13px] text-tekst-daempet">
                <Ikon navn="laas" className="h-4 w-4 shrink-0" />
                Betalingen er krypteret og håndteres af vores betalingspartner Stripe.
              </p>
            </div>
          </aside>
        </div>
      </div>

      {/* Mobil: total og knap fast i bunden, til prisoversigtens knap ses. */}
      {!knapSynlig && !lukket && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-kant bg-white px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgba(0,0,0,.06)] lg:hidden">
          <div className="mx-auto flex max-w-[640px] items-center gap-3">
            <div className="min-w-0 shrink-0">
              <p className="text-[12px] text-tekst-svag">Samlet beløb</p>
              <p className="text-lg leading-tight font-bold text-tekst tabular-nums">{kroner(totalVist)}</p>
            </div>
            <div className="min-w-0 flex-1">
              {knap(true)}
            </div>
          </div>
        </div>
      )}

      {!kunAfhentning && maade === "pakkeshop" && vaelgerAaben && (
        <PakkeshopVaelger
          onLuk={() => setVaelgerAaben(false)}
          onBekraeft={(s) => {
            setShop(s);
            setFeltFejl((f) => ({ ...f, shop: undefined }));
            setVaelgerAaben(false);
          }}
          startSoegning={
            (shop ? [shop.soegAdresse, shop.soegPostnummer || shop.postnummer].filter(Boolean).join(", ") : "") ||
            (slaaPostnummerOp(modtager.postnummer) ? `${modtager.adresse ? `${modtager.adresse}, ` : ""}${modtager.postnummer}` : "")
          }
          valgt={shop}
          transportoer={transportoer}
          firmaNavn={firmaer.length > 0 ? firmaNavn : null}
        />
      )}
    </main>
  );
}

function Linje({ navn, vaerdi }: { navn: string; vaerdi: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-tekst-daempet">
      <dt>{navn}</dt>
      <dd className="tabular-nums text-tekst">{vaerdi}</dd>
    </div>
  );
}

function FeltFejlTekst({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="mt-1.5 text-[13px] font-medium text-fejl-tekst">
      {children}
    </p>
  );
}

function Felt({
  id,
  label,
  fejl,
  hjaelp,
  className = "",
  children,
}: {
  id: string;
  label: string;
  fejl?: string;
  hjaelp?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-tekst">
        {label}
      </label>
      {children}
      {hjaelp && (
        <p id={`${id}-hjaelp`} className="mt-1.5 text-[13px] text-tekst-daempet">
          {hjaelp}
        </p>
      )}
      {fejl && <FeltFejlTekst id={`${id}-fejl`}>{fejl}</FeltFejlTekst>}
    </div>
  );
}

function FirmaKort({
  navn,
  firma,
  leveringstid,
  labelfri,
  pris,
  valgt,
  onVaelg,
}: {
  navn: string;
  firma: string;
  leveringstid: string;
  // false = sælgeren skal printe en label (GLS).
  labelfri: boolean;
  pris: string;
  valgt: boolean;
  onVaelg: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-3 rounded-xl border-2 p-3.5 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-groen sm:flex-col sm:items-start sm:gap-1.5 ${
        valgt ? "border-groen bg-groen-lys" : "border-kant hover:border-kant-staerk"
      }`}
    >
      <input type="radio" name={navn} checked={valgt} onChange={onVaelg} className="sr-only" />
      <span className="flex min-w-0 flex-1 items-center gap-3 sm:w-full">
        <span
          aria-hidden="true"
          className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${valgt ? "border-groen" : "border-kant-staerk"}`}
        >
          {valgt && <span className="h-2.5 w-2.5 rounded-full bg-groen" />}
        </span>
        <span className="text-[15px] font-bold text-tekst">{firma}</span>
      </span>
      <span className="shrink-0 text-right text-[13px] text-tekst-daempet sm:text-left">
        <span className="block">{leveringstid}</span>
        <span className="block">{labelfri ? "Sælger skal ikke printe" : "Sælger printer label"}</span>
        <span className="block font-semibold text-tekst tabular-nums">{pris}</span>
      </span>
    </label>
  );
}

function LeveringKort({
  navn,
  ikon,
  titel,
  tekst,
  pris,
  valgt,
  onVaelg,
}: {
  navn?: string;
  ikon: IkonNavn;
  titel: string;
  tekst: string;
  pris: string;
  valgt: boolean;
  onVaelg?: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-3 rounded-xl border-2 p-3.5 transition-colors sm:p-4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-groen ${
        valgt ? "border-groen bg-groen-lys" : "border-kant hover:border-kant-staerk"
      }`}
    >
      {navn ? (
        <input type="radio" name={navn} checked={valgt} onChange={() => onVaelg?.()} className="sr-only" />
      ) : null}
      <span
        aria-hidden="true"
        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${valgt ? "border-groen" : "border-kant-staerk"}`}
      >
        {valgt && <span className="h-2.5 w-2.5 rounded-full bg-groen" />}
      </span>
      <span className="hidden h-10 w-10 shrink-0 place-items-center rounded-lg bg-white text-groen-mork sm:grid">
        <Ikon navn={ikon} className="h-[22px] w-[22px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-tekst">{titel}</span>
        <span className="block text-[13px] text-tekst-daempet">{tekst}</span>
      </span>
      <span className="shrink-0 text-[15px] font-bold whitespace-nowrap text-tekst tabular-nums">{pris}</span>
    </label>
  );
}
