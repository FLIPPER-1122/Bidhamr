// Rene regler for erhvervsabonnementet (gratis periode og introrabat) - ingen
// Stripe-kald, ingen database. Bruges af src/lib/erhverv/betaling.ts og
// testes i tests/enhed/abonnementRegler.test.ts.
//
// Regler: ROADMAP-BESLUTNINGER.md, "Erhvervskonti" -> "NYE pakker og priser
// (Filip, 26.-27. okt. 2026)": Start har første måned gratis, Butik og Pro
// første måned til halv pris; introrabat (standard 50 % i måned 1-6, ingen
// gratis måned oveni) sættes manuelt.

export const INTRO_STANDARD = { procent: 50, maaneder: 6 } as const;
export const INTRO_GRAENSER = { procentMin: 1, procentMaks: 100, maanederMin: 1, maanederMaks: 24 } as const;
// Gratis periode pr. klik i admin (Filip: 1-3 måneder).
export const GRATIS_MAANEDER_MAKS = 3;
// Stripe: trial_end højst 730 dage frem.
export const TRIAL_MAKS_DAGE = 730;
export const BEGRUNDELSE = { min: 3, maks: 500 } as const;

export type IntroFra = "efter_gratis" | "straks";

// Kalendermåneder lagt til et tidspunkt (UTC), som Stripe gør det: findes
// dagen ikke i målmåneden (fx 31. januar + 1 måned), bruges månedens sidste
// dag. Klokkeslættet bevares.
export function plusMaaneder(sek: number, maaneder: number): number {
  const d = new Date(sek * 1000);
  const aar = d.getUTCFullYear();
  const maaned = d.getUTCMonth() + maaneder;
  const dag = d.getUTCDate();
  const sidsteDag = new Date(Date.UTC(aar, maaned + 1, 0)).getUTCDate();
  const ny = Date.UTC(aar, maaned, Math.min(dag, sidsteDag), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  return Math.floor(ny / 1000);
}

// En kupon med duration 'repeating' gælder alle fakturaer i de
// duration_in_months måneder, der starter, når kuponen sættes på (Stripe:
// docs.stripe.com/billing/subscriptions/coupons#coupon-duration) - også
// fakturaer i en gratis periode. Rabatten slutter ved start + K
// kalendermåneder (discount.end), og en faktura får rabat, hvis den kommer før
// slutningen. Fakturaerne kommer ved naesteFaktura + 0, 1, 2 ... måneder
// (regnet fra naesteFaktura - Stripes billing cycle anchor - ikke fra den
// forrige faktura). For præcis N BETALTE fakturaer med rabat skal
//   naesteFaktura + (N-1) måneder  <  start + K måneder  <  naesteFaktura + N måneder.
// Kuponen sættes på et sted i [nuSek, nuSek + marginSek] (Stripe sætter
// discount.start et øjeblik efter kaldet; i Checkout oprettes abonnementet
// senere end sessionen), og begge uligheder skal holde for HELE vinduet. NB:
// start + K måneder vokser ikke altid med start - 29. jan. 23:47 + 1 måned er
// 28. feb. 23:47, men 30. jan. 00:47 + 1 måned er 28. feb. 00:47 (månedens
// sidste dag). Inden for samme døgn vokser den, så vinduets endepunkter og
// hvert døgnskifte i vinduet tjekkes. K er det mindste tal, der opfylder den
// første ulighed for alle punkterne.
//
// Ved månedsskifte findes der ikke altid et K: kuponen tæller fra en anden
// dag i måneden end fakturaerne, og når fx start er den 31. og fakturaerne
// kommer den 30., springer start + K måneder over en hel fakturamåned (28.
// feb. 01:00 -> 31. mar. 01:00, mens fakturaerne er 28. feb. 23:00 og 30.
// mar. 23:00). Så svares null: kuponen kan ikke give præcis N lige nu, og den
// sættes på lidt senere (betalings-cron'en prøver igen hvert 5. minut - inden
// for et døgn passer det igen). Der gives aldrig N+1 eller N-1.
//
// fra 'straks': rabatten tæller fra nu (en gratis periode bruger af den) - K = N.
// Margin, når kuponen sættes på med et API-kald nu (discount.start ligger
// sekunder efter). Bagefter tjekkes Stripes faktiske discount.end alligevel.
export const INTRO_MARGIN_SEK = 300;
// Margin i Checkout: abonnementet oprettes typisk inden for en time.
export const INTRO_MARGIN_CHECKOUT_SEK = 3600;

// De tidspunkter i [fra, til], hvor start + K måneder er mindst og størst:
// endepunkterne og hvert døgnskifte (UTC) - sidste sekund før og første efter.
function vinduesPunkter(fra: number, til: number): number[] {
  const punkter = [fra, til];
  let midnat = Math.floor(fra / 86_400) * 86_400 + 86_400;
  while (midnat <= til) {
    punkter.push(midnat - 1, midnat);
    midnat += 86_400;
  }
  return punkter;
}

export function introKuponMaaneder(input: {
  nuSek: number;
  naesteFakturaSek: number;
  maaneder: number;
  fra: IntroFra;
  marginSek?: number;
}): number | null {
  const { nuSek, naesteFakturaSek, maaneder, fra } = input;
  const margin = input.marginSek ?? INTRO_MARGIN_SEK;
  if (!Number.isInteger(maaneder) || maaneder < 1) throw new Error("Ugyldigt antal måneder");
  if (!Number.isInteger(margin) || margin < 0 || margin > 86_400) throw new Error("Ugyldig margin");
  if (fra === "straks" || naesteFakturaSek <= nuSek) return maaneder;
  // Kan næste faktura komme, før kuponen er sat på? Så kan den ikke styres.
  if (naesteFakturaSek <= nuSek + margin) return null;
  const sidsteMedRabat = plusMaaneder(naesteFakturaSek, maaneder - 1);
  const foersteUden = plusMaaneder(naesteFakturaSek, maaneder);
  const punkter = vinduesPunkter(nuSek, nuSek + margin);
  const slut = (k: number) => punkter.map((p) => plusMaaneder(p, k));
  let k = 1;
  while (Math.min(...slut(k)) <= sidsteMedRabat) {
    k++;
    if (k > 400) throw new Error("Næste faktura ligger for langt ude");
  }
  if (Math.max(...slut(k)) >= foersteUden) return null;
  return k;
}

// Introkuponen sat på allerede i Stripe Checkout (så Checkout viser den
// rigtige pris efter den gratis periode). Kuponens måneder tæller fra, når
// ABONNEMENTET oprettes (når firmaet gennemfører Checkout) - det er efter
// sessionen (nuSek) og højst ~24 timer senere (sessionens levetid), mens
// trialEnd er låst i sessionen. Først prøves et K, der passer for hele døgnet;
// ellers et, der passer, hvis abonnementet oprettes inden for en time (det
// almindelige). Gennemfører firmaet senere, så rabatten ikke længere rammer
// præcis N betalte fakturaer (fx Checkout 30. aug. kl. 23 og abonnementet
// oprettet 31. aug. kl. 01), opdager spejlingen det (introPasser) og sætter
// kuponen på igen fra abonnementets faktiske tidspunkt. null: intet K passer
// - Checkout laves uden kupon, og webhooken/cron'en sætter den på.
// Uden gratis periode (første faktura ved oprettelsen) eller 'straks': K = N.
export function introKuponMaanederCheckout(input: {
  nuSek: number;
  trialEndSek: number | null;
  maaneder: number;
  fra: IntroFra;
}): number | null {
  const { nuSek, trialEndSek, maaneder, fra } = input;
  if (!Number.isInteger(maaneder) || maaneder < 1) throw new Error("Ugyldigt antal måneder");
  if (fra === "straks" || trialEndSek == null || trialEndSek <= nuSek) return maaneder;
  // Abonnementet oprettes tidligst sekundet EFTER sessionen (trialEnd er
  // nuSek + gratis måneder, så start = nuSek ville ramme en faktura præcis på
  // rabattens slutdato).
  const fra1 = nuSek + 1;
  return (
    introKuponMaaneder({ nuSek: fra1, naesteFakturaSek: trialEndSek, maaneder, fra, marginSek: 86_400 }) ??
    introKuponMaaneder({ nuSek: fra1, naesteFakturaSek: trialEndSek, maaneder, fra, marginSek: INTRO_MARGIN_CHECKOUT_SEK })
  );
}

// Giver en introrabat, der allerede ligger på abonnementet (fx fra Checkout),
// præcis N betalte fakturaer med rabat fra naesteFaktura? (Stripes faktiske
// discount.end, ikke en beregning.)
export function introPasser(input: { naesteFakturaSek: number; rabatSlutSek: number | null; maaneder: number }): boolean {
  return introResterende({ naesteFakturaSek: input.naesteFakturaSek, rabatSlutSek: input.rabatSlutSek }) === input.maaneder;
}

// Hvor mange BETALTE fakturaer har en kørende introrabat tilbage? Fakturaerne
// kommer ved naesteFaktura + 0, 1, 2 ... måneder; kuponen gælder fakturaer før
// dens slut (discount.end).
export function introResterende(input: { naesteFakturaSek: number; rabatSlutSek: number | null }): number {
  const { naesteFakturaSek, rabatSlutSek } = input;
  if (rabatSlutSek == null) return 0;
  let n = 0;
  while (plusMaaneder(naesteFakturaSek, n) < rabatSlutSek) {
    n++;
    if (n > 400) break;
  }
  return n;
}

// Ny trial_end, når staff giver +N gratis måneder. Er firmaet i en gratis
// periode, forlænges den; ellers starter de gratis måneder, når den betalte
// periode slutter (firmaet mister ikke det, det har betalt for).
export function nyGratisSlut(input: {
  status: string;
  trialEndSek: number | null;
  periodeSlutSek: number;
  nuSek: number;
  maaneder: number;
}): number {
  const { status, trialEndSek, periodeSlutSek, nuSek, maaneder } = input;
  const base = status === "trialing" && trialEndSek && trialEndSek > nuSek ? trialEndSek : Math.max(periodeSlutSek, nuSek);
  return plusMaaneder(base, maaneder);
}

export function gyldigBegrundelse(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  return s.length >= BEGRUNDELSE.min && s.length <= BEGRUNDELSE.maks ? s : null;
}

// --- Særpris og introrabat kan ikke kombineres (Filip, 27. okt. 2026) -----------
// Et firma har enten en særpris eller rabat på normalprisen, aldrig begge. Samme
// regel som databasen (erhverv_intro_gaelder/erhverv_saerpris_gaelder,
// 20261102050000). At fjerne den ene eller den anden er altid tilladt.

// Introrabat, der er planlagt (ingen slutdato endnu) eller kører (slutdato i
// fremtiden). intro_status alene kan ikke bruges - den står 'aktiv', til Stripe
// har meldt rabatten færdig.
export function introGaelder(
  f: { intro_procent: number | null | undefined; intro_til: string | null | undefined },
  nuMs: number = Date.now(),
): boolean {
  if (f.intro_procent == null) return false;
  return !f.intro_til || new Date(f.intro_til).getTime() > nuMs;
}

// Særpris på firmaets nuværende pakke (en særpris på en anden pakke er
// bortfaldet ved pakkeskift).
export function saerprisGaelder(f: {
  saerpris_oere: number | string | null | undefined;
  saerpris_pakke_id: string | null | undefined;
  pakke_id: string;
}): boolean {
  return f.saerpris_oere != null && f.saerpris_pakke_id === f.pakke_id;
}

// --- Gratis måned til et CVR, der har haft abonnement før (Filip, 27. okt. 2026) -
// Ingen gratis måned - kun som særaftale med en begrundelse på 5-500 tegn
// (erhverv_firma_opret, 20261102050000).
export const SAERAFTALE_BEGRUNDELSE = { min: 5, maks: 500 } as const;

export function gyldigSaeraftaleBegrundelse(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  return s.length >= SAERAFTALE_BEGRUNDELSE.min && s.length <= SAERAFTALE_BEGRUNDELSE.maks ? s : null;
}

// Ret til velkomstfordelen ved oprettelse: 1 for et nyt CVR; 0 for et CVR, der
// har haft abonnement før, medmindre staff giver den som særaftale.
export function velkomstMaanederVedOprettelse(input: { cvrTidligere: boolean; saeraftale: boolean }): 0 | 1 {
  return !input.cvrTidligere || input.saeraftale ? 1 : 0;
}

// --- Regel for måned 1 (Filip, 27. okt. 2026) ------------------------------------
// Start: første måned gratis. Butik og Pro: første måned til halv pris (50 %),
// derefter fuld pris - aldrig gratis. Introrabat (50 % i måned 1-6) erstatter
// velkomstfordelen. Databasen: erhverv_pakker.maaned1 og erhverv_maaned1
// (20261102070000).
export type Maaned1 = "gratis" | "halv" | "ingen";
export type PakkeMaaned1 = "gratis" | "halv";
export const VELKOMST_RABAT_PROCENT = 50;
// Start-pakken (samme id i test og produktion, 20261102010000) - kun brugt,
// hvis migrationen 20261102070000 ikke er kørt endnu.
export const START_PAKKE_ID = "7e57a000-0000-4000-8000-000000000001";

// Særpris udelukker også velkomstfordelen (Filip, 27. okt. 2026): særprisen
// gælder fra første betaling - ingen gratis måned og ingen 50 %
// (erhverv_maaned1, 20261102150000).
export function maaned1Regel(input: {
  pakke: PakkeMaaned1;
  velkomst: boolean;
  introGaelder: boolean;
  saerprisGaelder: boolean;
}): Maaned1 {
  if (!input.velkomst || input.introGaelder || input.saerprisGaelder) return "ingen";
  return input.pakke;
}

// Rabatten på første betaling ved et skift op fra Starts gratis velkomstmåned
// til Butik/Pro (opgraderFraVelkomst) - og HVILKEN slags rabat det er, så
// teksten ikke skal gætte ud fra procenten (en introrabat kan også være 50 %):
//   saerpris: 0 % (ingen velkomstfordel, og særprisen bortfalder ved skiftet)
//   intro:    introrabattens procent (den bliver liggende i stedet for 50 %)
//             til dens slutdato (til; null, hvis den ikke er sat på endnu)
//   velkomst: 50 % nu, fuld pris fra næste måned.
export type VelkomstSkiftRabat =
  | { slags: "velkomst"; procent: number }
  | { slags: "intro"; procent: number; til: string | null; maaneder: number }
  | { slags: "saerpris"; procent: 0 };

export function velkomstSkiftRabat(input: {
  saerprisGaelder: boolean;
  intro: { procent: number; til: string | null; maaneder: number } | null;
}): VelkomstSkiftRabat {
  if (input.saerprisGaelder) return { slags: "saerpris", procent: 0 };
  if (input.intro) return { slags: "intro", procent: input.intro.procent, til: input.intro.til, maaneder: input.intro.maaneder };
  return { slags: "velkomst", procent: VELKOMST_RABAT_PROCENT };
}

// Hvad et skift op fra Starts gratis velkomstmåned til Butik/Pro gør - ÉN
// regel for både siden (beløbet, der vises) og serveren (beløbet, der trækkes;
// opgraderFraVelkomst), ud fra databasens aftale OG rabatterne på abonnementet
// i Stripe (20261102200000-rettelserne):
//   skift:     rabatten er afklaret - firmaet betaler pakkens pris med rabat
//              nu. velkomstKupon: 50 %-engangskuponen sættes på i skiftet;
//              ellers bruges rabatten, der allerede ligger på abonnementet.
//   venter:    introrabatten er aftalt ('planlagt'), men kuponen på
//              abonnementet hører ikke til netop den aftale (eller der er
//              ingen). Intet trækkes - rabatten sættes på først.
//   ret_rabat: databasen og Stripe er uenige (fx 'aktiv' uden kupon, en
//              introkupon uden aftale eller en fremmed rabat). Intet trækkes,
//              og staff skal rette det (drift-alarm). aarsag til alarmen.
// Firmaet må aldrig blive trukket et andet beløb end det, siden har vist.
export type VelkomstSkiftUdfald =
  | { udfald: "skift"; rabat: VelkomstSkiftRabat; velkomstKupon: boolean }
  | { udfald: "venter" }
  | { udfald: "ret_rabat"; aarsag: string };

export type VelkomstIntroKupon = {
  kuponId: string;
  procent: number | null;
  // discount.end (sekunder) - null for en kupon uden slutdato.
  slutSek: number | null;
};

export function velkomstSkiftUdfald(input: {
  saerprisGaelder: boolean;
  aftale: {
    status: string | null;
    procent: number | null;
    maaneder: number | null;
    kuponId: string | null;
    noegle: string | null;
    // introGaelder: aftalt og ikke udløbet.
    gaelder: boolean;
  };
  abonnement: {
    // BidHamrs introkuponer på abonnementet (metadata.bidhamr = 'intro').
    introer: VelkomstIntroKupon[];
    // Alle andre rabatter på abonnementet (fx en kupon sat direkte i Stripe).
    andre: number;
    // subscription.metadata.intro_noegle (sat af Checkout for netop den aftale).
    introNoegle: string | null;
  };
  // Dansk dato for discount.end (fx langDato).
  dato: (sek: number) => string;
}): VelkomstSkiftUdfald {
  const { aftale, abonnement } = input;
  if (abonnement.andre > 0) {
    return { udfald: "ret_rabat", aarsag: `abonnementet har ${abonnement.andre} rabat(ter), som ikke er BidHamrs introrabat` };
  }
  if (abonnement.introer.length > 1) {
    return { udfald: "ret_rabat", aarsag: `abonnementet har ${abonnement.introer.length} introkuponer` };
  }
  const kupon = abonnement.introer[0] ?? null;
  const medIntro = (k: VelkomstIntroKupon, procent: number, maaneder: number): VelkomstSkiftUdfald => ({
    udfald: "skift",
    rabat: velkomstSkiftRabat({
      saerprisGaelder: false,
      intro: { procent, til: k.slutSek != null ? input.dato(k.slutSek) : null, maaneder },
    }),
    velkomstKupon: false,
  });

  if (aftale.status === "planlagt" && aftale.procent != null && aftale.maaneder != null) {
    // Kun en kupon, der hører til NETOP denne aftale (Checkout satte den på
    // med aftalens nøgle), og med aftalens procent. En kupon fra en tidligere
    // aftale (eller ingen) -> vent: den rigtige sættes på først.
    const hoererTil =
      !!kupon && !!aftale.noegle && abonnement.introNoegle === aftale.noegle && kupon.procent === aftale.procent;
    return hoererTil ? medIntro(kupon, aftale.procent, aftale.maaneder) : { udfald: "venter" };
  }
  if (aftale.status === "aktiv" && aftale.gaelder && aftale.procent != null && aftale.maaneder != null) {
    if (kupon && aftale.kuponId && kupon.kuponId === aftale.kuponId && kupon.procent === aftale.procent) {
      return medIntro(kupon, aftale.procent, aftale.maaneder);
    }
    return {
      udfald: "ret_rabat",
      aarsag: kupon
        ? `introrabatten står som aktiv i databasen (${aftale.kuponId ?? "ingen kupon"}, ${aftale.procent} %), men abonnementet har en anden introkupon (${kupon.kuponId}, ${kupon.procent ?? "?"} %)`
        : `introrabatten står som aktiv i databasen (${aftale.kuponId ?? "ingen kupon"}, ${aftale.procent} %), men ligger ikke på abonnementet`,
    };
  }
  // Ingen kørende aftale i databasen (intro_status null, eller udløbet).
  if (kupon) {
    return {
      udfald: "ret_rabat",
      aarsag: `abonnementet har introkuponen ${kupon.kuponId} (${kupon.procent ?? "?"} %), men firmaet har ingen kørende introrabat i databasen (intro_status ${aftale.status ?? "null"})`,
    };
  }
  if (input.saerprisGaelder) return { udfald: "skift", rabat: velkomstSkiftRabat({ saerprisGaelder: true, intro: null }), velkomstKupon: false };
  return { udfald: "skift", rabat: velkomstSkiftRabat({ saerprisGaelder: false, intro: null }), velkomstKupon: true };
}

// Hvad siden viste for et skift op fra den gratis måned (sendes med skiftet,
// så serveren kan afvise, hvis rabatten er ændret imens): "velkomst:50",
// "intro:30", "saerpris:0" - eller "venter"/"ret_rabat", når der ikke blev
// vist et beløb. Kun beløbet I DAG tæller (slags + procent).
export function velkomstVisning(u: VelkomstSkiftUdfald): string {
  return u.udfald === "skift" ? `${u.rabat.slags}:${u.rabat.procent}` : u.udfald;
}

export function erVelkomstVisning(v: unknown): v is string {
  return typeof v === "string" && /^(velkomst:\d{1,3}|intro:\d{1,3}|saerpris:0|venter|ret_rabat)$/.test(v);
}

// Beløbet ekskl. og inkl. moms i hele øre (moms 25 %, afrundet til nærmeste
// øre som i Stripe) for en månedspris i kroner med rabat i procent.
export function oereMedRabat(maanedsprisKr: number, rabatProcent: number): { ekskl: number; inkl: number } {
  const fuld = Math.round(maanedsprisKr * 100);
  const ekskl = fuld - Math.round((fuld * rabatProcent) / 100);
  return { ekskl, inkl: ekskl + Math.round((ekskl * 25) / 100) };
}

// Hvad Checkout skal gøre: gratis måneder (trial) og om engangskuponen på 50 %
// skal på. Staff-givne måneder (ekstra) er en særaftale: Start får dem oven i
// velkomstmåneden; for Butik/Pro erstatter de 50 %-måneden (ingen dobbelt
// rabat - en 'once'-kupon ville ellers blive brugt på 0-kr.-fakturaen).
export function checkoutPlan(input: { maaned1: Maaned1; velkomstMaaneder: number; ekstra: number }): {
  velkomstGratis: number;
  ekstra: number;
  halvPris: boolean;
} {
  const ekstra = Math.max(0, Math.min(Math.trunc(input.ekstra), 24));
  if (input.maaned1 === "gratis") {
    const velkomstGratis = Math.max(0, Math.min(Math.trunc(input.velkomstMaaneder), 1, 24 - ekstra));
    return { velkomstGratis, ekstra, halvPris: false };
  }
  if (input.maaned1 === "halv") return { velkomstGratis: 0, ekstra, halvPris: ekstra === 0 };
  return { velkomstGratis: 0, ekstra, halvPris: false };
}

// Er abonnementets gratis periode KUN Starts velkomstmåned (ingen særaftale)?
// Så må et skift op til Butik/Pro ikke være gratis: den gratis periode slutter,
// og firmaet betaler 50 % af den nye pakke for sin første måned med den.
// Metadata sættes af startBetaling (maaned1, gratis_ekstra) og af staff-
// handlingerne (gratis_saeraftale = 'ja').
export function erKunVelkomstGratis(metadata: Record<string, string> | null | undefined): boolean {
  if (!metadata || metadata.maaned1 !== "gratis") return false;
  if (metadata.gratis_saeraftale === "ja") return false;
  const ekstra = Number(metadata.gratis_ekstra ?? 0);
  return !(Number.isFinite(ekstra) && ekstra > 0);
}

// --- Rettelser 4 af måned 1-skiftet (27. okt. 2026) ---------------------------

// "visning" fra siden eller appen (POST /api/firma/skift-pakke): mangler den
// (undefined/null), er den null; en sendt værdi skal være gyldig - ellers
// afvises forespørgslen (400 ugyldig_visning) i stedet for stille at blive null.
export function tolkVelkomstVisning(v: unknown): { ok: true; visning: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, visning: null };
  return erVelkomstVisning(v) ? { ok: true, visning: v } : { ok: false };
}

// Er et skift til pakken et skift op fra Starts gratis velkomstmåned, som
// koster pakkens pris med rabat nu (opgraderFraVelkomst)? Samme regel som
// siden (PakkeValg.fraVelkomst): firmaet er i velkomstmåneden, pakken er
// større, er ikke gratis i måned 1 og har en pris.
export function erVelkomstSkiftTil(input: {
  iVelkomstMaaned: boolean;
  stoerre: boolean;
  maaned1: string | null | undefined;
  maanedsprisKr: number | null;
}): boolean {
  return input.iVelkomstMaaned && input.stoerre && input.maaned1 !== "gratis" && input.maanedsprisKr != null;
}

// Hvad appen får vist før et skift op fra den gratis måned (GET
// /api/firma/skift-pakke?til=<pakke>) - SAMME udfald som serveren bruger ved
// skiftet. visning sendes med i POST'en. beloeb kun ved udfald 'skift'.
export type VelkomstSkiftTilbud = {
  udfald: VelkomstSkiftUdfald["udfald"];
  visning: string;
  rabat: VelkomstSkiftRabat | null;
  beloeb: { eksklOere: number; inklOere: number } | null;
  // false ved ret_rabat: serveren afviser skiftet (vis ingen knap).
  kanSkifte: boolean;
};

export function velkomstSkiftTilbud(u: VelkomstSkiftUdfald, maanedsprisKr: number): VelkomstSkiftTilbud {
  if (u.udfald !== "skift") {
    return { udfald: u.udfald, visning: velkomstVisning(u), rabat: null, beloeb: null, kanSkifte: u.udfald === "venter" };
  }
  const b = oereMedRabat(maanedsprisKr, u.rabat.procent);
  return {
    udfald: "skift",
    visning: velkomstVisning(u),
    rabat: u.rabat,
    beloeb: { eksklOere: b.ekskl, inklOere: b.inkl },
    kanSkifte: true,
  };
}

// Rabatten i procent på en faktura (ekskl. moms): rabatbeløbet mod beløbet
// før rabat. total_excluding_tax er efter alle rabatter, og
// total_discount_amounts er rabatterne summeret over alle linjer
// (docs.stripe.com/api/invoices/object). null uden beløb.
export function rabatProcentPaaFaktura(
  totalEksklMoms: number | null | undefined,
  rabatter: { amount: number }[] | null | undefined,
): number | null {
  if (totalEksklMoms == null) return null;
  const rabat = (rabatter ?? []).reduce((s, r) => s + r.amount, 0);
  const foer = totalEksklMoms + rabat;
  if (foer <= 0) return null;
  return Math.round((rabat * 100) / foer);
}

// Drift-alarmen "rabatten skal rettes" (ret_rabat) kommer én gang pr. firma og
// aftale, ikke ved hvert klik: nøglen er drift_fejl.digest, som databasen
// dedupper på (drift_fejl_log: samme digest inden for 24 timer tæller kun
// op). Aftalen er intro_noegle (uuid) - en ny aftale giver en ny alarm.
export function retRabatAlarmNoegle(firmaId: string, introNoegle: string | null): string {
  const ren = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 36);
  return `vrr-${ren(firmaId)}-${introNoegle ? ren(introNoegle) : "ingen"}`;
}

// Noten på pakkeskiftet, når skiftet op fra den gratis måned er betalt - med
// den rigtige rabat (50 % = halv pris; en introrabat på 30 % er ikke halv pris).
export function velkomstBetaltNote(procent: number | null): string {
  const start = "Skiftet op i den gratis måned: den gratis periode sluttede, og første måned af den nye pakke er betalt";
  if (procent == null) return start;
  if (procent === 50) return `${start} til halv pris`;
  if (procent <= 0) return `${start} til fuld pris`;
  return `${start} med ${procent} % rabat`;
}
