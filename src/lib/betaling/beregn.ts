// Gebyrer, fragt og BidHamr Beskyttelse i øre (heltal). Samme formler som i
// databasen (public.prismodel_koebergebyr_oere / prismodel_saelgergebyr_oere
// og koebergebyr_oere / saelgergebyr_oere, 20261102140000_glidende_gebyrer.sql)
// - databasen er den, der gemmer beløbene; denne fil bruges til at vise og
// kontrollere.
//
// Privat prismodel med glidende overgang (prismodel 'ny2', Filip 27. okt. 2026
// - ROADMAP-BESLUTNINGER afsnit 3 og 4):
//   Salgspris (vindende bud) til og med 7.500,00 kr.:
//     købergebyr 7 % + 5 kr., højst 300 kr.; sælgergebyr 5 % + 5 kr., højst 95 kr.
//   Salgspris over 7.500,00 kr. (det lave trins loft + en procent af beløbet
//   OVER 7.500 kr., så den samlede pris aldrig falder, når buddet stiger):
//     købergebyr 300 kr. + 3 % af (pris - 7.500), højst 650 kr.;
//     sælgergebyr 95 kr. + 2 % af (pris - 7.500), højst 450 kr.
//   Erhverv (auctions.erhverv, prismodel 'erhverv2'): købergebyr 5 % uden
//   min/maks og INTET sælgergebyr (Filip, 26. okt. 2026 - firmaer betaler
//   allerede abonnement; 20261101010000_erhverv_intet_saelgergebyr.sql).
//   Udbetaling = hele buddet.
//   Alle gebyrer er inkl. moms og rundes til hele øre (halv op).
//   BidHamr Beskyttelse er ikke et tilkøb længere: ved forsendelse (privat) er
//   handlen altid beskyttet, og prisen ligger i købergebyret
//   (betalinger.beskyttelse = true, beskyttelse_oere = 0). Afhentning og
//   erhverv: ingen Beskyttelse.
//   Fragt (Filip 9. okt. 2026, priser 26. okt. 2026): pris efter
//   pakkestørrelse og leveringsmåde i tabellen fragt_pakkestoerrelser (ét
//   sted). Prisen låses på auktionen (auctions.fragt_pakkeshop_oere /
//   fragt_doer_oere), og betalingens fragt_oere sættes af databasen ud fra
//   købers leveringsvalg i checkout. Kun afhentning = 0 kr.
//   Udbetaling til sælger = bud - sælgergebyr. Fragten bliver på BidHamrs
//   platformskonto og går videre til fragtfirmaet.
//
// Prismodellen er låst pr. betaling fra oprettelsen (betalinger.prismodel).
// Handler, der allerede er vundet, beholder deres beløb:
//   'ny'     (26.-27. okt. 2026): over 7.500 kr. 3 % + 15 kr. (højst 650 kr.)
//            og 2 % + 15 kr. (højst 450 kr.) af hele prisen.
// Gamle betalinger (betalinger.prismodel = 'gammel', før 26. okt. 2026) har
// 5 %/5 % og evt. et tilkøbt BidHamr Beskyttelse-beløb (beskyttelse_oere > 0)
// - de vises og kontrolleres med de gamle formler. Erhvervshandler fra før
// 20261101010000 (prismodel 'erhverv') havde 5 %/5 % og beholder det; nye
// erhvervshandler er 'erhverv2' (5 % købergebyr, 0 kr. sælgergebyr).

// Grænsen mellem de to satser: 7.500,00 kr. (til og med = lav sats).
export const GEBYR_GRAENSE_OERE = 750_000;

// Til og med grænsen: procent af salgsprisen + fast beløb, højst loftet (øre).
export const KOEBERGEBYR_LAV = { procent: 7, fastOere: 500, maksOere: 30_000 } as const;
export const SAELGERGEBYR_LAV = { procent: 5, fastOere: 500, maksOere: 9_500 } as const;
// Over grænsen ('ny2', glidende): det lave trins loft + procent af beløbet
// OVER grænsen, højst loftet (øre).
export const KOEBERGEBYR_OVER = { procent: 3, maksOere: 65_000 } as const;
export const SAELGERGEBYR_OVER = { procent: 2, maksOere: 45_000 } as const;
// Kun gemte 'ny'-handler (26.-27. okt. 2026): over grænsen procent af HELE
// salgsprisen + fast beløb, højst loftet.
export const KOEBERGEBYR_HOEJ_NY = { procent: 3, fastOere: 1_500, maksOere: 65_000 } as const;
export const SAELGERGEBYR_HOEJ_NY = { procent: 2, fastOere: 1_500, maksOere: 45_000 } as const;
// Erhvervsauktioner: købergebyret i den gamle model (uden fast beløb og
// loft). Sælgergebyret er 0 for nye erhvervshandler (20261101010000); gamle
// erhvervshandler (prismodel 'erhverv') havde også 5 % sælgergebyr.
export const ERHVERV_GEBYR_PROCENT = 5;

// Beløbsloft for startpris, bud og maksimum (hele kroner) - også erhverv.
// Databasen: public.maks_beloeb_kr() og beloebsloft_*.
export const MAKS_BELOEB_KR = 25_000;

// Den gamle faste fragt. Bruges kun til visning på auktioner uden låst pris
// (oprettet før 20261012010000 - databasen gav dem samme 35 kr.).
export const FRAGT_OERE = 3500;

// Chefens beløbsgrænse (Filip, 12. okt. 2026): 10.000 kr. Fra og med
// grænsen kræver en admin-frigivelse chefen, og en udbetaling til sælgeren
// venter på chefens godkendelse - uanset hvordan pengene blev frigivet (også
// via en sag). Begge regner på købers samlede betaling (i databasen
// greatest(total_oere, udbetaling_oere)). Under grænsen må
// admin selv frigive. Databasen afgør det: public.chef_beloebsgraense_oere()
// (20261019010000_pengesikkerhed.sql) - samme tal her til lister og tekster.
export const CHEF_BELOEBSGRAENSE_OERE = 1_000_000;

// Udbetaling til sælgerens bank højst hver 14. dag (20261031010000,
// public.saelger_naeste_udbetaling_kl).
export const UDBETALING_INTERVAL_DAGE = 14;

// betalinger.prismodel (20261031010000; 'erhverv2' fra 20261101010000; 'ny2'
// fra 20261102140000).
export type Prismodel = "gammel" | "ny" | "ny2" | "erhverv" | "erhverv2";

// Prismodellen for en NY handel (public.aktuel_prismodel).
export function aktuelPrismodel(erhverv: boolean): Prismodel {
  return erhverv ? "erhverv2" : "ny2";
}

// Er betalingen en erhvervshandel (gammel 5 %/5 % eller ny uden sælgergebyr)?
export function erErhvervPrismodel(m: Prismodel | string | null | undefined): boolean {
  return m === "erhverv" || m === "erhverv2";
}

// Privat handel i den nye model (26. okt. 2026 ff.): BidHamr Beskyttelse i
// gebyret, og ved medhold i en sag refunderes kun buddet. 'ny' og 'ny2' er
// ens på alt andet end gebyrerne over 7.500 kr.
export function erNyPrivatPrismodel(m: Prismodel | string | null | undefined): boolean {
  return m === "ny" || m === "ny2";
}

// Halv op til nærmeste øre, som Postgres' round() på positive tal.
function procentAf(oere: number, procent: number): number {
  return Math.round((oere * procent) / 100);
}

function sats(budOere: number, s: { procent: number; fastOere: number; maksOere: number }): number {
  return Math.min(procentAf(budOere, s.procent) + s.fastOere, s.maksOere);
}

// Glidende ('ny2'): til og med grænsen det lave trin; over grænsen det lave
// trins loft + procent af beløbet over grænsen, højst loftet.
function glidende(
  budOere: number,
  lav: { procent: number; fastOere: number; maksOere: number },
  over: { procent: number; maksOere: number },
): number {
  if (budOere <= GEBYR_GRAENSE_OERE) return sats(budOere, lav);
  return Math.min(lav.maksOere + procentAf(budOere - GEBYR_GRAENSE_OERE, over.procent), over.maksOere);
}

// Købergebyret for en prismodel (public.prismodel_koebergebyr_oere).
// null = ukendt prismodel.
export function koebergebyrForPrismodel(model: Prismodel | string, budOere: number): number | null {
  switch (model) {
    case "ny2":
      return glidende(budOere, KOEBERGEBYR_LAV, KOEBERGEBYR_OVER);
    case "ny":
      return sats(budOere, budOere <= GEBYR_GRAENSE_OERE ? KOEBERGEBYR_LAV : KOEBERGEBYR_HOEJ_NY);
    case "gammel":
    case "erhverv":
    case "erhverv2":
      return procentAf(budOere, ERHVERV_GEBYR_PROCENT);
    default:
      return null;
  }
}

// Sælgergebyret for en prismodel (public.prismodel_saelgergebyr_oere).
// Firmaer betaler intet sælgergebyr ('erhverv2', 20261101010000).
// null = ukendt prismodel.
export function saelgergebyrForPrismodel(model: Prismodel | string, budOere: number): number | null {
  switch (model) {
    case "ny2":
      return glidende(budOere, SAELGERGEBYR_LAV, SAELGERGEBYR_OVER);
    case "ny":
      return sats(budOere, budOere <= GEBYR_GRAENSE_OERE ? SAELGERGEBYR_LAV : SAELGERGEBYR_HOEJ_NY);
    case "gammel":
    case "erhverv":
      return procentAf(budOere, ERHVERV_GEBYR_PROCENT);
    case "erhverv2":
      return 0;
    default:
      return null;
  }
}

// Gebyret for en NY handel (public.koebergebyr_oere / saelgergebyr_oere):
// privat glidende ('ny2'), erhverv 5 % / 0 kr. ('erhverv2'). Bruges til
// totalprisen før buddet, tilbud til næste byder og opret auktion.
export function koebergebyrOere(budOere: number, erhverv: boolean): number {
  return koebergebyrForPrismodel(aktuelPrismodel(erhverv), budOere) as number;
}

export function saelgergebyrOere(budOere: number, erhverv: boolean): number {
  return saelgergebyrForPrismodel(aktuelPrismodel(erhverv), budOere) as number;
}

// Det, sælgeren får udbetalt (bud - sælgergebyr).
export function udbetalingOere(budOere: number, erhverv: boolean): number {
  return budOere - saelgergebyrOere(budOere, erhverv);
}

// Er handlen dækket af BidHamr Beskyttelse? Kun private handler, der sendes.
export function erBeskyttet(erhverv: boolean, forsendelse: boolean): boolean {
  return forsendelse && !erhverv;
}

// Fragten køberen ser før buddet: auktionens låste pakkeshop-pris (billigste
// leveringsmåde). Visning - beløbet i betalingen sætter databasen.
export function fragtOere(forsendelseMulig: boolean, pakkeshopOere?: number | null): number {
  if (!forsendelseMulig) return 0;
  return typeof pakkeshopOere === "number" && pakkeshopOere > 0 ? pakkeshopOere : FRAGT_OERE;
}

// Hvad køberen betaler i alt i den nye model: bud + gebyr + fragt
// (BidHamr Beskyttelse er i gebyret).
export function koeberTotalOere(budOere: number, erhverv: boolean, fragt: number): number {
  return budOere + koebergebyrOere(budOere, erhverv) + fragt;
}

// Den gamle BidHamr Beskyttelse (tilkøb før 26. okt. 2026): 5 % af buddet,
// min 25 kr., maks 250 kr. Kun historik: til at vise og kontrollere gamle
// betalinger (prismodel 'gammel'). Nye handler har intet tilkøb.
export function gammelBeskyttelseOere(budOere: number): number {
  return Math.min(Math.max(procentAf(budOere, 5), 2_500), 25_000);
}

export type BetalingsBeloeb = {
  bud_oere: number;
  koebergebyr_oere: number;
  saelgergebyr_oere: number;
  fragt_oere: number;
  beskyttelse_oere: number;
  // Mangler kolonnen (migrationen 20261031010000 er ikke kørt): den gamle
  // model - det er den, databasen så stadig regner med.
  prismodel?: Prismodel | null;
};

// Kontrol af en gemt betaling: totalen, som formlerne giver for rækkens
// prismodel - eller null, hvis købergebyret, sælgergebyret eller Beskyttelsen
// ikke passer med formlen (så må der ikke betales). Bruges før en
// PaymentIntent oprettes. Sælgergebyret tjekkes også her (forsvar i dybden):
// det indgår i BidHamrs application fee og dermed i sælgerens udbetaling.
export function forventetTotalOere(b: BetalingsBeloeb): number | null {
  const bud = Number(b.bud_oere);
  const koeb = Number(b.koebergebyr_oere);
  const saelg = Number(b.saelgergebyr_oere);
  const fragt = Number(b.fragt_oere);
  const besk = Number(b.beskyttelse_oere);
  const model = b.prismodel ?? "gammel";
  // Gebyrerne efter betalingens egen (låste) prismodel. Ukendt prismodel:
  // der må ikke betales.
  const forventetKoeb = koebergebyrForPrismodel(model, bud);
  const forventetSaelg = saelgergebyrForPrismodel(model, bud);
  if (forventetKoeb === null || forventetSaelg === null) return null;
  if (koeb !== forventetKoeb || saelg !== forventetSaelg) return null;
  if (model === "gammel") {
    // Gamle handler: evt. tilkøbt BidHamr Beskyttelse.
    if (besk !== 0 && besk !== gammelBeskyttelseOere(bud)) return null;
    return bud + koeb + fragt + besk;
  }
  // Alle andre modeller: intet særskilt Beskyttelse-beløb.
  if (besk !== 0) return null;
  return bud + koeb + fragt;
}

// Refusion ved medhold i en sag (public.sag_refusion_oere): ny og ny2 = kun
// buddet (Filip, 26. okt. 2026 - gebyr og fragt refunderes ikke); gammel,
// erhverv og erhverv2 = alt undtagen BidHamr Beskyttelse.
// Sagstypen (20261102210000, Filip 27. okt. 2026): bortkommet pakke og
// transportskade = HELE beløbet (bud + gebyr + fragt) for alle modeller.
export const SAG_TYPER_HELE_BELOEBET = ["bortkommet", "skadet"] as const;

export function sagRefusionOere(
  b: {
    prismodel?: Prismodel | null;
    bud_oere: number;
    total_oere: number;
    beskyttelse_oere: number | null;
  },
  type?: string | null,
): number {
  if (type && (SAG_TYPER_HELE_BELOEBET as readonly string[]).includes(type)) return Number(b.total_oere);
  if (erNyPrivatPrismodel(b.prismodel)) return Number(b.bud_oere);
  return Number(b.total_oere) - Number(b.beskyttelse_oere ?? 0);
}

// Teksten på købers gebyrlinje (faktura og kvittering) - samme som
// public.faktura_koebergebyr_tekst.
export function koebergebyrTekst(prismodel: Prismodel | null | undefined, beskyttet: boolean): string {
  if (!prismodel || prismodel === "gammel") return "Købergebyr (5 %)";
  return beskyttet ? "Gebyr (inkl. BidHamr Beskyttelse)" : "Gebyr";
}

// Betalingsmodel destination: BidHamrs application fee på PaymentIntenten =
// købergebyr + sælgergebyr + fragt + BidHamr Beskyttelse (alle inkl. moms;
// Beskyttelse er 0 i den nye model).
// Sælgeren står tilbage med total - fee = bud - sælgergebyr = udbetaling_oere
// (CHECK betalinger_destination_gebyr_stemmer i databasen).
export function applicationFeeOere(b: {
  koebergebyr_oere: number;
  saelgergebyr_oere: number;
  fragt_oere: number;
  beskyttelse_oere: number;
}): number {
  return (
    Number(b.koebergebyr_oere) +
    Number(b.saelgergebyr_oere) +
    Number(b.fragt_oere) +
    Number(b.beskyttelse_oere)
  );
}
