import "server-only";

// Returfragt i sager (Filip, 13. okt. 2026): køberen betaler selv
// returfragten med kort, Apple Pay, Google Pay, MobilePay eller Revolut Pay
// (betalingsmetoder.ts), FØR returkoden
// (DAO Shop2Shop, labelfri) laves. Migration 20261022010000_returfragt_betaling.sql.
//
// Pengestrømmen:
//   1. returfragt_start låser prisen (= fragten ud) på en række i
//      returfragt_betalinger (én aktiv pr. handel).
//   2. En PaymentIntent på BidHamrs PLATFORMSKONTO - ingen on_behalf_of,
//      ingen transfer_data, intet application fee: returfragten er BidHamrs
//      betaling for fragt, ikke sælgerens penge. Tvungen 3D Secure ('any').
//      Idempotency key pr. række og forsøg. Metadata: type 'returfragt',
//      returfragt_id, trade_id, sag_id, bidhamr_db.
//   3. Webhooken (payment_intent.succeeded) registrerer betalingen
//      (returfragt_registrer) - FØRST DA laves returkoden (efter svaret, med
//      after()). Databasen afviser en returlabel uden betalt række
//      (forsendelser_returfragt_vagt). Mistet webhook: cron'en slår
//      PaymentIntenten op hos Stripe efter 15 minutter.
//   4. Kan labelen ikke laves, prøver cron'en igen (5, 10, 20, 40, 80 min), og
//      staff markeres (på returforsendelsen under Fragt). Efter 5 fejl, 48
//      timer, eller hvis sagen ikke længere kræver retur, refunderes HELE
//      returfragten automatisk (idempotency key pr. forsøg; eksisterende
//      refusioner slås op først), og køberen får besked.
//   5. Fakturaen (fragtkonto, med moms) og evt. kreditnota laves af
//      fakturakøen (faktura_planlaeg_returfragt).
//
// Stripe er sandheden: databasen spejler kun. Alle beløb i øre.
//
// Transportskade med medhold (Filip, 27. okt. 2026 - 20261102210000):
// køberen betaler IKKE returfragten. Staff har valgt sælgeren (dårlig
// indpakning) eller BidHamr (god indpakning). returfragt_start laver da en
// DÆKKET række (betaler 'saelger'/'bidhamr', status 'betalt' uden
// PaymentIntent - kode 'daekket'), og returkoden laves med det samme. Der er
// ingen Stripe-betaling at refundere: kan koden ikke laves, annulleres rækken
// (returfragt_daekket_annuller). Sælgeren opkræves som ekstra fragt, når
// returpakken er afleveret (sag_retur_afleveret).

import Stripe from "stripe";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe, kraevSammeOffentligeNoegle, StripeTilstandFejl } from "@/lib/stripe";
import { logDriftFejl, renFejltekst } from "@/lib/drift";
import { egenDatabase } from "@/lib/betaling/fremmedeTestdata";
import { hentNoedstop, NYE_BETALINGER_STOPPET_TEKST } from "@/lib/betaling/noedstop";
import { alarmPrTilfaelde } from "@/lib/betaling/driftTilfaelde";
import { annullerForkerteMetoder, metodeHandling, metodeNoegle } from "@/lib/betaling/betalingsmetoder";
import { hentPlatformMetoder } from "@/lib/betaling/platformMetoder";
import { kundeSessionTilCheckout, sikrStripeKunde, type BetalingsKanal } from "@/lib/betaling/stripeBetaling";
import { send } from "@/lib/notifikationer/send";
import { kroner } from "@/lib/kroner";
import { fragtReturlabelAktiv } from "@/lib/fragt";
import { opretReturForsendelse, RETUR_I_GANG_TEKST, valideerAdresse, type AdresseInput } from "@/lib/fragt/server";

type Admin = ReturnType<typeof createAdminClient>;

export const RETURFRAGT_TYPE = "returfragt";
export const RETURLABEL_SLAAET_FRA_TEKST = "Returlabel via BidHamr er ikke slået til endnu. Skriv til BidHamr i sagen.";
const GENERISK = "Betalingen kunne ikke startes. Prøv igen om lidt.";

// Efter så mange fejl (eller 48 timer) refunderes returfragten automatisk -
// samme tal som returfragt_cron i databasen.
export const RETURLABEL_MAKS_FEJL = 5;

export type ReturfragtBetaler = "koeber" | "saelger" | "bidhamr";

export type ReturfragtRaekke = {
  id: string;
  // Hvem der betaler (20261102210000). Mangler kolonnen: 'koeber'.
  betaler?: ReturfragtBetaler;
  trade_id: string;
  sag_id: string;
  koeber_id: string;
  beloeb_oere: number;
  status: "afventer" | "behandles" | "betalt" | "refunderes" | "refunderet" | "annulleret";
  stripe_payment_intent_id: string | null;
  pi_forsoeg: number;
  stripe_charge_id: string | null;
  modtaget_oere: number | null;
  afsender: AdresseInput | null;
  betalt_kl: string | null;
  forsendelse_id: string | null;
  label_klar_kl: string | null;
  label_fejl_antal: number;
  refusion_aarsag: string | null;
  refusion_forsoeg: number;
  stripe_refund_id: string | null;
};

const GAMLE_KOLONNER =
  "id, trade_id, sag_id, koeber_id, beloeb_oere, status, stripe_payment_intent_id, pi_forsoeg, stripe_charge_id, " +
  "modtaget_oere, afsender, betalt_kl, forsendelse_id, label_klar_kl, label_fejl_antal, refusion_aarsag, " +
  "refusion_forsoeg, stripe_refund_id";
const KOLONNER = `${GAMLE_KOLONNER}, betaler`;

// Er rækken dækket af sælgeren/BidHamr (ingen Stripe-betaling)?
export function erDaekket(rf: Pick<ReturfragtRaekke, "betaler">): boolean {
  return !!rf.betaler && rf.betaler !== "koeber";
}

// Tabellen findes ikke (migrationen er ikke kørt endnu).
export function manglerTabel(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST202" ||
    err.code === "42883" ||
    /does not exist|Could not find the (table|function)/i.test(err.message ?? "")
  );
}

async function hentRaekke(admin: Admin, id: string): Promise<ReturfragtRaekke | null> {
  let { data, error } = await admin
    .from("returfragt_betalinger")
    .select(KOLONNER)
    .eq("id", id)
    .maybeSingle<ReturfragtRaekke>();
  // Før 20261102210000 findes betaler ikke (alle rækker er købers).
  if (error?.code === "42703") {
    ({ data, error } = await admin
      .from("returfragt_betalinger")
      .select(GAMLE_KOLONNER)
      .eq("id", id)
      .maybeSingle<ReturfragtRaekke>());
  }
  if (error) throw new Error(`returfragt_betalinger: ${error.message}`);
  return data;
}

// Rækken for en PaymentIntent (også en kasseret). null = ikke en returfragt.
export async function returfragtForPi(piId: string): Promise<ReturfragtRaekke | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("returfragt_betalinger")
    .select(KOLONNER)
    .eq("stripe_payment_intent_id", piId)
    .maybeSingle<ReturfragtRaekke>();
  if (error) {
    if (manglerTabel(error)) return null;
    throw new Error(`returfragt_betalinger: ${error.message}`);
  }
  if (data) return data;
  const { data: kasseret, error: kFejl } = await admin
    .from("returfragt_betalinger")
    .select(KOLONNER)
    .contains("tidligere_payment_intents", [piId])
    .limit(1)
    .maybeSingle<ReturfragtRaekke>();
  if (kFejl) throw new Error(`returfragt_betalinger (kasseret): ${kFejl.message}`);
  return kasseret;
}

// Er PaymentIntenten (ud fra metadata) en returfragt? Uden opslag.
export function erReturfragtMetadata(md: Stripe.Metadata | null | undefined): boolean {
  return md?.type === RETURFRAGT_TYPE && typeof md.returfragt_id === "string";
}

function stripeId(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

// Kør efter svaret (webhook/server action), eller med det samme uden for en
// request (cron, test). Kaster aldrig.
function efterSvar(navn: string, opgave: () => Promise<unknown>): void {
  const p = () =>
    opgave().catch((err) => logDriftFejl({ kilde: "server", hvor: `Returfragt: ${navn}`, fejl: err }));
  try {
    after(p);
  } catch {
    void p();
  }
}

// ------------------------------------------------------------------ start

const START_FEJL: Record<string, string> = {
  ugyldig: "Ugyldigt valg.",
  ikke_fundet: "Handlen findes ikke.",
  ingen_sag: "Der er ingen sag, hvor varen skal sendes retur.",
  ingen_retur: "Der er ingen sag, hvor varen skal sendes retur.",
  afleveret: "Returen er allerede registreret.",
  anke: "Afgørelsen er anket. Vent med at sende varen, til anken er afgjort.",
  ankefrist: "Vent med at sende varen, til sælgerens ankefrist er udløbet.",
  mangler_adresse: "Sælgerens adresse mangler, så returlabelen kan ikke laves. Skriv til BidHamr i sagen.",
  ingen_betaling: "Handlen er ikke betalt, så der kan ikke sendes retur via BidHamr.",
  ingen_pris: "Returfragten kunne ikke beregnes. Skriv til BidHamr i sagen.",
};

export type ReturfragtStart =
  | {
      ok: true;
      daekket?: false;
      clientSecret: string;
      beloebOere: number;
      // Stripe-kunden på PaymentIntenten (PaymentSheet: customerId sammen med
      // customerSessionClientSecret, som i betal).
      customerId: string | null;
      customerSessionClientSecret: string | null;
    }
  | { fejl: string; betalt?: true }
  // Transportskade: sælgeren eller BidHamr betaler - ingen betaling; returkoden
  // er sat i gang (eller lavet). label: resultatet af første forsøg.
  | {
      ok: true;
      daekket: true;
      clientSecret: null;
      beloebOere: number;
      customerId: null;
      customerSessionClientSecret: null;
      betaler: "saelger" | "bidhamr";
      label: LabelResultat | null;
    };

// Køberen starter (eller genoptager) betalingen af returfragten. koeberId SKAL
// være verificeret med auth af kalderen; databasen tjekker igen under lås.
// afsender (valgfri): køberens adresse og mobil til labelen - gemmes på
// rækken (appen sender den her; hjemmesiden gemmer den lige før betalingen).
export async function startReturfragtBetaling(
  tradeId: string,
  koeberId: string,
  afsender?: AdresseInput | null,
  kanal: BetalingsKanal = "web",
): Promise<ReturfragtStart> {
  if (!fragtReturlabelAktiv()) return { fejl: RETURLABEL_SLAAET_FRA_TEKST };
  try {
    try {
      await kraevSammeOffentligeNoegle();
    } catch (err) {
      if (err instanceof StripeTilstandFejl) return { fejl: GENERISK };
      throw err;
    }
    if ((await hentNoedstop()).nyeBetalingerStoppet) return { fejl: NYE_BETALINGER_STOPPET_TEKST };
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("returfragt_start", { p_trade: tradeId, p_koeber: koeberId });
    if (error) throw new Error(`returfragt_start: ${error.message}`);
    const s = data as { kode?: string; id?: string; betaler?: string; beloeb_oere?: number } | null;
    if (s?.kode === "daekket" && s.id) {
      // Ingen betaling: adressen gemmes (appen sender den her), og returkoden
      // laves med det samme. Uden adresse venter rækken på den (som efter en
      // betaling - lavReturlabelAction / app "returlabel").
      if (afsender) {
        const gemt = await gemReturAfsender(s.id, koeberId, afsender);
        if ("fejl" in gemt) return gemt;
      }
      const label = afsender ? await lavReturlabelEfterBetaling(s.id, "koeber") : null;
      return {
        ok: true,
        daekket: true,
        clientSecret: null,
        beloebOere: Number(s.beloeb_oere ?? 0),
        customerId: null,
        customerSessionClientSecret: null,
        betaler: s.betaler === "saelger" ? "saelger" : "bidhamr",
        label,
      };
    }
    if (s?.kode === "betalt" || s?.kode === "refunderes") return { fejl: "Returfragten er allerede betalt.", betalt: true };
    if ((s?.kode !== "ok" && s?.kode !== "findes") || !s.id) return { fejl: START_FEJL[s?.kode ?? ""] ?? GENERISK };
    if (afsender) {
      const gemt = await gemReturAfsender(s.id, koeberId, afsender);
      if ("fejl" in gemt) return gemt;
    }
    const rf = await hentRaekke(admin, s.id);
    if (!rf) return { fejl: GENERISK };
    const pi = await sikrReturfragtPi(rf);
    if (pi.status === "succeeded" || pi.status === "processing") {
      await spejlReturfragtPi(pi);
      return { fejl: "Returfragten er allerede betalt.", betalt: true };
    }
    if (pi.status === "canceled" || pi.amount !== Number(rf.beloeb_oere) || !pi.client_secret) return { fejl: GENERISK };
    return {
      ok: true,
      clientSecret: pi.client_secret,
      beloebOere: pi.amount,
      customerId: typeof pi.customer === "string" ? pi.customer : (pi.customer?.id ?? null),
      customerSessionClientSecret: await kundeSessionTilCheckout(koeberId, pi, kanal),
    };
  } catch (err) {
    console.error("startReturfragtBetaling fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "Returfragt: start", fejl: err, brugerId: koeberId });
    return { fejl: GENERISK };
  }
}

// Køberens afsenderadresse (valideres her, gemmes under lås i databasen).
export async function gemReturAfsender(
  rfId: string,
  koeberId: string,
  input: AdresseInput,
): Promise<{ ok: true } | { fejl: string }> {
  const a = valideerAdresse(input, { kraevAdresse: true, kraevTelefon: true });
  if ("fejl" in a) return a;
  const { data, error } = await createAdminClient().rpc("returfragt_gem_afsender", {
    p_id: rfId,
    p_koeber: koeberId,
    p_afsender: {
      navn: a.adresse.navn,
      adresse: a.adresse.adresse,
      postnummer: a.adresse.postnummer,
      by: a.adresse.by,
      telefon: a.adresse.telefon,
    },
  });
  if (error) throw new Error(`returfragt_gem_afsender: ${error.message}`);
  if (data === "ok") return { ok: true };
  if (data === "laast") return { fejl: "Returkoden er allerede lavet, så adressen kan ikke ændres." };
  return { fejl: "Returfragten findes ikke." };
}

// Køberen gemmer sin adresse lige før betalingen (hjemmesiden).
export async function gemReturAfsenderForHandel(
  tradeId: string,
  koeberId: string,
  input: AdresseInput,
): Promise<{ ok: true } | { fejl: string }> {
  const { data, error } = await createAdminClient()
    .from("returfragt_betalinger")
    .select("id")
    .eq("trade_id", tradeId)
    .eq("koeber_id", koeberId)
    .in("status", ["afventer", "behandles", "betalt"])
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`returfragt_betalinger: ${error.message}`);
  if (!data) return { fejl: "Start betalingen af returfragten igen." };
  return gemReturAfsender(data.id, koeberId, input);
}

const OPDATERBARE: Stripe.PaymentIntent.Status[] = ["requires_payment_method", "requires_confirmation"];

function metadata(rf: ReturfragtRaekke): Stripe.MetadataParam {
  const db = egenDatabase();
  return {
    type: RETURFRAGT_TYPE,
    returfragt_id: rf.id,
    trade_id: rf.trade_id,
    sag_id: rf.sag_id,
    koeber_id: rf.koeber_id,
    ...(db ? { bidhamr_db: db } : {}),
  };
}

// Den ene PaymentIntent for rækken (oprettes én gang pr. forsøg).
async function sikrReturfragtPi(rf: ReturfragtRaekke, forsoeg = 0): Promise<Stripe.PaymentIntent> {
  const stripe = getStripe();
  const admin = createAdminClient();
  const beloeb = Number(rf.beloeb_oere);
  if (!Number.isInteger(beloeb) || beloeb < 300) throw new Error(`Ugyldigt returfragt-beløb for ${rf.id}`);

  if (rf.stripe_payment_intent_id) {
    const eks = await stripe.paymentIntents.retrieve(rf.stripe_payment_intent_id);
    if (eks.status === "canceled" && rf.status === "afventer") {
      const { data: ok, error } = await admin.rpc("returfragt_nulstil_pi", { p_id: rf.id, p_pi: eks.id });
      if (error) throw new Error(`returfragt_nulstil_pi: ${error.message}`);
      if (ok !== true || forsoeg >= 2) throw new Error("Returfragtens PaymentIntent kunne ikke nulstilles");
      const ny = await hentRaekke(admin, rf.id);
      if (!ny) throw new Error("Returfragten findes ikke");
      return sikrReturfragtPi(ny, forsoeg + 1);
    }
    // Betalingsmetoderne (Filip, 20. okt. 2026): en åben PaymentIntent med
    // automatic_payment_methods (Klarna, Link ...) kan ikke opdateres til en
    // eksplicit liste - den annulleres, og næste runde nulstiller rækken
    // (pi_forsoeg + 1 = ny idempotency key) og laver en ny.
    const metoder = await hentPlatformMetoder();
    const metodeValg = metodeHandling(eks, metoder);
    if (metodeValg === "annuller") {
      if (rf.status !== "afventer" || forsoeg >= 2) throw new Error("Returfragtens PaymentIntent har forkerte betalingsmetoder");
      const efter = await annullerForkerteMetoder(stripe, eks.id);
      if (efter.status !== "canceled") return efter; // betalt imens - kalderen spejler
      // Rækken hentes igen: webhooken (payment_intent.canceled) kan have
      // nulstillet den imens, så den gamle række ikke længere passer.
      const ny = await hentRaekke(admin, rf.id);
      if (!ny) throw new Error("Returfragten findes ikke");
      return sikrReturfragtPi(ny, forsoeg + 1);
    }
    // Beløbet er låst i databasen; 3D Secure tvinges også på ældre intents.
    const mangler3ds = eks.payment_method_options?.card?.request_three_d_secure !== "any";
    if (
      (eks.amount !== beloeb || mangler3ds || eks.metadata?.returfragt_id !== rf.id || metodeValg === "opdater") &&
      OPDATERBARE.includes(eks.status)
    ) {
      return stripe.paymentIntents.update(eks.id, {
        amount: beloeb,
        payment_method_types: metoder,
        metadata: metadata(rf),
        payment_method_options: { card: { request_three_d_secure: "any" } },
      });
    }
    return eks;
  }

  const kunde = await sikrStripeKunde(rf.koeber_id);
  const db = egenDatabase();
  // Metoderne er med i nøglen: en PaymentIntent fra før (automatic_payment_
  // methods) under samme nøgle, men aldrig gemt, giver en ny i stedet for
  // Stripes idempotensfejl.
  const metoder = await hentPlatformMetoder();
  const noegle = `bidhamr-returfragt-${rf.id}-${rf.pi_forsoeg}${db ? `-${db}` : ""}-${metodeNoegle(metoder)}`;
  const pi = await stripe.paymentIntents.create(
    {
      amount: beloeb,
      currency: "dkk",
      customer: kunde,
      // Kun de tilladte metoder (betalingsmetoder.ts, Filip 20. okt. 2026):
      // kort (inkl. Apple Pay/Google Pay), MobilePay og Revolut Pay - aldrig
      // Klarna eller Link. Betaling til platformen: ingen on_behalf_of,
      // ingen transfer_data, intet application fee.
      payment_method_types: metoder,
      payment_method_options: { card: { request_three_d_secure: "any" } },
      description: `BidHamr returfragt for handel ${rf.trade_id}`,
      metadata: metadata(rf),
    },
    { idempotencyKey: noegle },
  );

  const { data: gemt, error } = await admin.rpc("returfragt_gem_pi", {
    p_id: rf.id,
    p_pi: pi.id,
    p_forsoeg: rf.pi_forsoeg,
  });
  if (error) {
    // Næste kald får samme PaymentIntent tilbage via nøglen (24 t).
    throw new Error(`returfragt_gem_pi: ${error.message}`);
  }
  if (gemt === true) return pi;
  const efter = await hentRaekke(admin, rf.id);
  if (efter?.stripe_payment_intent_id && efter.stripe_payment_intent_id !== pi.id) {
    // Et samtidigt kald nåede først: brug dens, og annullér vores, så der
    // aldrig ligger to betalbare intents.
    await stripe.paymentIntents.cancel(pi.id).catch((err: unknown) => console.error("Overskydende returfragt-PI:", pi.id, err));
    return stripe.paymentIntents.retrieve(efter.stripe_payment_intent_id);
  }
  if (efter?.stripe_payment_intent_id === pi.id) return pi;
  // Rækken er ændret imens (fx annulleret): vores intent må ikke kunne betales.
  await stripe.paymentIntents.cancel(pi.id).catch((err: unknown) => console.error("Forældet returfragt-PI:", pi.id, err));
  if (!efter || efter.status !== "afventer" || forsoeg >= 2) throw new Error("Returfragten kunne ikke startes");
  return sikrReturfragtPi(efter, forsoeg + 1);
}

// ------------------------------------------------------------------ spejl fra Stripe

// Spejler en returfragt-PaymentIntent (webhook og cron). Idempotent.
// Svar: databasens kode ('betalt', 'allerede', 'ukendt' ...).
export async function spejlReturfragtPi(pi: Stripe.PaymentIntent): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("returfragt_registrer", {
    p_pi: pi.id,
    p_status: pi.status,
    p_charge: stripeId(pi.latest_charge as string | { id: string } | null),
    p_beloeb: pi.status === "succeeded" ? pi.amount_received : null,
    p_fejl: pi.last_payment_error?.code ?? pi.last_payment_error?.message ?? null,
  });
  if (error) {
    if (manglerTabel(error)) return "ukendt";
    throw new Error(`returfragt_registrer: ${error.message}`);
  }
  const svar = data as { kode?: string; id?: string } | null;
  const kode = svar?.kode ?? "ukendt";
  if (kode === "betalt" && svar?.id) {
    const id = svar.id;
    // Returkoden laves efter svaret (DAO kan tage op til ca. 50 s).
    efterSvar("lav returkode", () => lavReturlabelEfterBetaling(id, "betaling"));
  }
  if (kode === "beloeb_afviger" && svar?.id) {
    await alarmPrTilfaelde({
      noegle: `returfragt-beloeb:${svar.id}`,
      hvor: "betaling/returfragt",
      fejl: `Returfragt ${svar.id} (PaymentIntent ${pi.id}) er betalt med et andet beløb end prisen. Den refunderes automatisk - kontrollér i Stripe.`,
    });
    await refunderReturfragt(svar.id);
  }
  if (kode === "kasseret") await refunderKasseret(pi, svar?.id ?? null);
  return kode;
}

// En kasseret (annulleret i databasen) PaymentIntent er alligevel betalt:
// køberen har betalt to gange - den refunderes helt. Idempotent.
async function refunderKasseret(pi: Stripe.PaymentIntent, rfId: string | null): Promise<void> {
  const stripe = getStripe();
  const eksisterende = await stripe.refunds.list({ payment_intent: pi.id, limit: 20 });
  if (!eksisterende.data.some((r) => r.status !== "failed" && r.status !== "canceled")) {
    await stripe.refunds.create(
      {
        payment_intent: pi.id,
        reason: "duplicate",
        metadata: { type: RETURFRAGT_TYPE, returfragt_id: rfId ?? "", kasseret: "ja", ...(egenDatabase() ? { bidhamr_db: egenDatabase()! } : {}) },
      },
      { idempotencyKey: `bidhamr-returfragt-kasseret-${pi.id}` },
    );
  }
  await alarmPrTilfaelde({
    noegle: `returfragt-kasseret:${pi.id}`,
    hvor: "betaling/returfragt",
    fejl: `En kasseret PaymentIntent for returfragt ${rfId ?? "?"} (${pi.id}) er betalt - mulig dobbeltbetaling. Den er refunderet automatisk; kontrollér i Stripe.`,
  });
}

// ------------------------------------------------------------------ returkoden

async function titelForHandel(admin: Admin, tradeId: string): Promise<string> {
  const { data: t } = await admin.from("trades").select("auction_id, seller_id").eq("id", tradeId).maybeSingle<{ auction_id: string; seller_id: string }>();
  if (!t) return "din vare";
  const { data: a } = await admin.from("auctions").select("titel").eq("id", t.auction_id).maybeSingle<{ titel: string | null }>();
  return a?.titel ?? "din vare";
}

export type LabelResultat = { ok: true; forsendelseId: string } | { fejl: string };

// Laver returkoden for en BETALT returfragt (efter webhooken, køberens nye
// forsøg eller cron'en). Bruger den eksisterende fragt-logik
// (opretReturForsendelse: claim, genoptag efter ukendt udfald, forældreløse
// DAO-pakker annulleres). Fejl tælles (spredte forsøg), og staff markeres.
// Kaster aldrig.
export async function lavReturlabelEfterBetaling(
  rfId: string,
  kilde: "betaling" | "koeber" | "cron",
): Promise<LabelResultat> {
  const admin = createAdminClient();
  try {
    const rf = await hentRaekke(admin, rfId);
    if (!rf || rf.status !== "betalt") return { fejl: "Betal returfragten, før returkoden kan laves." };
    if (rf.label_klar_kl && rf.forsendelse_id) return { ok: true, forsendelseId: rf.forsendelse_id };
    if (!rf.betalt_kl) return { fejl: "Betal returfragten, før returkoden kan laves." };
    // Kræver sagen ikke længere retur (fx genåbnet eller omgjort), laves der
    // ingen kode: returfragten refunderes i stedet.
    const { data: sag, error: sFejl } = await admin.rpc("returfragt_sag", { p_trade: rf.trade_id });
    if (sFejl) throw new Error(`returfragt_sag: ${sFejl.message}`);
    if ((sag as { kode?: string } | null)?.kode !== "ok") {
      await claimOgRefunder(admin, rf);
      return { fejl: "Sagen kræver ikke længere, at varen sendes retur. Returfragten sendes tilbage til dig." };
    }
    if (!rf.afsender) {
      // Ikke en fejl hos fragtfirmaet: køberen skal skrive sin adresse. Tæller
      // ikke som et forsøg (kun 48-timersgrænsen gælder).
      const tekst = "Skriv din adresse og dit mobilnummer, så laver vi returkoden.";
      await admin.rpc("returfragt_label_venter", { p_id: rf.id, p_brugerfejl: tekst });
      return { fejl: tekst };
    }
    const r = await opretReturForsendelse(rf.trade_id, rf.koeber_id, rf.afsender);
    if ("ok" in r) {
      const efter = await hentRaekke(admin, rf.id);
      if (efter?.label_klar_kl) await beskedLabelKlar(admin, efter);
      return r;
    }
    // Et forsøg er allerede i gang (fx webhook og cron samtidig) - ingen fejl.
    if (r.fejl === RETUR_I_GANG_TEKST) return r;
    const { data: antal, error } = await admin.rpc("returfragt_label_fejlet", {
      p_id: rf.id,
      p_brugerfejl: r.fejl,
      p_intern: `${kilde}: ${r.fejl}`,
    });
    if (error) throw new Error(`returfragt_label_fejlet: ${error.message}`);
    const n = Number(antal ?? 0);
    if (n === 1 || n === RETURLABEL_MAKS_FEJL) {
      await markerStaff(
        rf.id,
        n === 1
          ? `Returfragten er betalt, men returkoden kunne ikke laves (${r.fejl}). Systemet prøver selv igen; efter ${RETURLABEL_MAKS_FEJL} fejl eller 48 timer refunderes returfragten automatisk.`
          : `Returkoden kunne ikke laves efter ${RETURLABEL_MAKS_FEJL} forsøg (${r.fejl}). Returfragten refunderes automatisk - tjek fragtfirmaet og sagen.`,
      );
    }
    if (n === 1 && kilde !== "koeber") {
      const titel = await titelForHandel(admin, rf.trade_id);
      await send(rf.koeber_id, "sag", {
        titel: "Returkoden er ikke klar endnu",
        tekst: `Din betaling af returfragten for "${titel}" er gennemført, men fragtfirmaet kunne ikke lave returkoden endnu: ${r.fejl} Vi prøver igen automatisk. Du skal ikke betale igen.`,
        link: `/mine-handler/${rf.trade_id}`,
        data: { trade_id: rf.trade_id },
        noegle: `returlabel_fejl:${rf.id}`,
      });
    }
    return r;
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Returfragt: lav returkode", fejl: err });
    return { fejl: "Returkoden kunne ikke laves lige nu. Vi prøver igen automatisk – du skal ikke betale igen." };
  }
}

async function markerStaff(rfId: string, note: string): Promise<void> {
  const { data, error } = await createAdminClient().rpc("returfragt_marker", { p_id: rfId, p_note: note });
  if (error || data !== true) {
    // Ingen returforsendelse at hænge markeringen på: drift-alarm i stedet.
    await alarmPrTilfaelde({
      noegle: `returfragt:${rfId}:${note.slice(0, 40)}`,
      hvor: "betaling/returfragt",
      fejl: `Returfragt ${rfId}: ${note}`,
    });
  }
}

async function beskedLabelKlar(admin: Admin, rf: ReturfragtRaekke): Promise<void> {
  const { data: t } = await admin.from("trades").select("seller_id").eq("id", rf.trade_id).maybeSingle<{ seller_id: string }>();
  const titel = await titelForHandel(admin, rf.trade_id);
  const link = `/mine-handler/${rf.trade_id}`;
  await send(rf.koeber_id, "sag", {
    titel: "Din returkode er klar",
    tekst: erDaekket(rf)
      ? `Din returkode til "${titel}" er klar. Du betaler ikke returfragten. Vis koden i en pakkeshop, når du afleverer pakken - se koden på handelssiden.`
      : `Returfragten for "${titel}" er betalt, og din returkode er klar. Vis koden i en pakkeshop, når du afleverer pakken - se koden på handelssiden.`,
    link,
    data: { trade_id: rf.trade_id },
    noegle: `returlabel_klar:${rf.id}`,
  });
  if (t?.seller_id) {
    await send(t.seller_id, "sag", {
      titel: "Varen er på vej retur",
      tekst: `Køberen har fået en returkode og sender "${titel}" retur til dig. Pakken sendes til en pakkeshop tæt på dig. Du kan følge den på handelssiden.`,
      link,
      data: { trade_id: rf.trade_id },
      noegle: `returlabel_saelger:${rf.id}`,
    });
  }
}

// Køberen (eller appen) giver en ny/rettet adresse efter betalingen og
// prøver igen. koeberId SKAL være verificeret med auth.
export async function proevReturlabelIgen(
  tradeId: string,
  koeberId: string,
  afsender: AdresseInput | null | undefined,
): Promise<LabelResultat> {
  if (!fragtReturlabelAktiv()) return { fejl: RETURLABEL_SLAAET_FRA_TEKST };
  const admin = createAdminClient();
  const { data: rf, error } = await admin
    .from("returfragt_betalinger")
    .select("id, status, label_klar_kl, forsendelse_id")
    .eq("trade_id", tradeId)
    .eq("koeber_id", koeberId)
    .in("status", ["afventer", "behandles", "betalt", "refunderes"])
    .maybeSingle<{ id: string; status: string; label_klar_kl: string | null; forsendelse_id: string | null }>();
  if (error) {
    await logDriftFejl({ kilde: "action", sti: "fragt", hvor: "Returfragt: prøv igen", fejl: error, brugerId: koeberId });
    return { fejl: "Noget gik galt. Prøv igen om lidt." };
  }
  if (!rf || rf.status === "afventer" || rf.status === "behandles") {
    return { fejl: "Betal returfragten, før returkoden kan laves." };
  }
  if (rf.status === "refunderes") return { fejl: "Returfragten er ved at blive refunderet. Skriv til BidHamr i sagen." };
  if (rf.label_klar_kl && rf.forsendelse_id) return { ok: true, forsendelseId: rf.forsendelse_id };
  if (afsender) {
    try {
      const g = await gemReturAfsender(rf.id, koeberId, afsender);
      if ("fejl" in g) return g;
    } catch (err) {
      await logDriftFejl({ kilde: "action", sti: "fragt", hvor: "Returfragt: gem adresse", fejl: err, brugerId: koeberId });
      return { fejl: "Noget gik galt. Prøv igen om lidt." };
    }
  }
  return lavReturlabelEfterBetaling(rf.id, "koeber");
}

// ------------------------------------------------------------------ refusion

// Refunderer HELE returfragten for en claimet række ('refunderes'). Aldrig
// dobbelt: eksisterende refusioner på PaymentIntenten slås op først, og
// nøglen er fast pr. række og forsøg. Svar: databasens kode. Kaster aldrig.
export async function refunderReturfragt(rfId: string): Promise<string> {
  const admin = createAdminClient();
  const stripe = getStripe();
  let rf: ReturfragtRaekke | null = null;
  try {
    rf = await hentRaekke(admin, rfId);
    if (!rf) return "ikke_fundet";
    if (rf.status === "refunderet") {
      await beskedRefunderet(admin, rf.id);
      return "allerede";
    }
    if (rf.status !== "refunderes" || !rf.stripe_payment_intent_id) return "forkert_status";
    const piId = rf.stripe_payment_intent_id;
    const alle = await stripe.refunds.list({ payment_intent: piId, limit: 100 });
    const aktive = alle.data.filter((r) => r.status !== "failed" && r.status !== "canceled");
    const vores = aktive.find((r) => r.metadata?.returfragt_id === rf!.id);
    let refund: Stripe.Refund | null = vores ?? null;
    if (!refund && aktive.length > 0) {
      // Refunderet uden om BidHamr (fx i dashboardet): opret intet nyt.
      const sum = aktive.reduce((s, r) => s + r.amount, 0);
      const betalt = Number(rf.modtaget_oere ?? rf.beloeb_oere);
      if (sum >= betalt) refund = aktive[0];
      else {
        await markerStaff(rf.id, "Returfragten er delvist refunderet uden om BidHamr - refundér resten manuelt i Stripe.");
        const { data } = await admin.rpc("returfragt_refusion_resultat", {
          p_id: rf.id,
          p_ok: false,
          p_refund: null,
          p_fejl: "Delvis refusion uden om BidHamr",
        });
        return String(data);
      }
    }
    if (!refund) {
      refund = await stripe.refunds.create(
        {
          payment_intent: piId,
          metadata: {
            type: RETURFRAGT_TYPE,
            returfragt_id: rf.id,
            trade_id: rf.trade_id,
            sag_id: rf.sag_id,
            ...(egenDatabase() ? { bidhamr_db: egenDatabase()! } : {}),
          },
        },
        { idempotencyKey: `bidhamr-returfragt-refusion-${rf.id}-${rf.refusion_forsoeg}` },
      );
    }
    const ok = refund.status !== "failed" && refund.status !== "canceled";
    const { data, error } = await admin.rpc("returfragt_refusion_resultat", {
      p_id: rf.id,
      p_ok: ok,
      p_refund: refund.id,
      p_fejl: ok ? null : `Refusionen ${refund.status === "failed" ? "fejlede" : "blev annulleret"} hos Stripe`,
    });
    if (error) throw new Error(`returfragt_refusion_resultat: ${error.message}`);
    const kode = String(data);
    // Også 'allerede' (charge.refunded kan nå at registrere refusionen først):
    // beskeden har en fast nøgle pr. returfragt, så den sendes kun én gang.
    if (kode === "refunderet" || kode === "allerede") await beskedRefunderet(admin, rf.id);
    if (kode === "opgivet") await markerStaff(rf.id, "Refusionen af returfragten er fejlet 5 gange - refundér manuelt i Stripe.");
    return kode;
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Returfragt: refusion", fejl: err });
    if (rf?.status === "refunderes") {
      const { data } = await admin.rpc("returfragt_refusion_resultat", {
        p_id: rf.id,
        p_ok: false,
        p_refund: null,
        p_fejl: renFejltekst(err, 300),
      });
      if (String(data) === "opgivet") {
        await markerStaff(rf.id, "Refusionen af returfragten er fejlet 5 gange - refundér manuelt i Stripe.");
      }
    }
    return "fejl";
  }
}

// Besked til køberen om, at returfragten er refunderet. Rækken læses frisk
// (årsagen kan være sat af en anden vej, fx charge.refunded). Fast nøgle pr.
// returfragt: sendes kun én gang, uanset hvilken vej der kommer først.
async function beskedRefunderet(admin: Admin, rfId: string): Promise<void> {
  const rf = await hentRaekke(admin, rfId);
  if (!rf || rf.status !== "refunderet") return;
  const titel = await titelForHandel(admin, rf.trade_id);
  const beloeb = kroner(Number(rf.modtaget_oere ?? rf.beloeb_oere));
  const tekst =
    rf.refusion_aarsag === "ikke_noedvendig"
      ? `Sagen om "${titel}" kræver ikke længere, at du sender varen retur, så du har fået returfragten (${beloeb}) tilbage.`
      : rf.refusion_aarsag === "staff" || rf.refusion_aarsag === "ekstern"
        ? `BidHamr har refunderet returfragten (${beloeb}) for "${titel}". Har du allerede fået en returkode, kan du ikke længere bruge den. Skriv til BidHamr i sagen, hvis du har spørgsmål.`
        : `Returkoden for "${titel}" kunne ikke laves, så du har fået returfragten (${beloeb}) tilbage. Skriv til BidHamr i sagen, så hjælper vi dig med at sende varen.`;
  await send(rf.koeber_id, "sag", {
    titel: "Returfragten er sendt tilbage",
    tekst: `${tekst} Pengene går tilbage til den betalingsmetode, du betalte med - der kan gå nogle dage. Betalingen håndteres af vores betalingspartner Stripe.`,
    link: `/mine-handler/${rf.trade_id}`,
    data: { trade_id: rf.trade_id },
    noegle: `returfragt_refunderet:${rf.id}`,
  });
}

// Claim + refusion (cron). Svar: kode. En dækket række (sælger/BidHamr
// betaler) har ingen Stripe-betaling - den annulleres i stedet.
async function claimOgRefunder(admin: Admin, rf: ReturfragtRaekke): Promise<string> {
  const { data: sag } = await admin.rpc("returfragt_sag", { p_trade: rf.trade_id });
  const aarsag = (sag as { kode?: string } | null)?.kode === "ok" ? "label_umulig" : "ikke_noedvendig";
  if (erDaekket(rf)) {
    const { data, error } = await admin.rpc("returfragt_daekket_annuller", { p_id: rf.id, p_aarsag: aarsag });
    if (error) throw new Error(`returfragt_daekket_annuller: ${error.message}`);
    const kode = String(data);
    if (kode === "ok") {
      await alarmPrTilfaelde({
        noegle: `returfragt-daekket:${rf.id}`,
        hvor: "betaling/returfragt",
        fejl:
          aarsag === "ikke_noedvendig"
            ? `Dækket returfragt ${rf.id}: sagen kræver ikke længere retur - rækken er annulleret.`
            : `Dækket returfragt ${rf.id}: returkoden kunne ikke laves - rækken er annulleret. Hjælp køberen med returen i sagen.`,
      });
      if (aarsag === "label_umulig") {
        const titel = await titelForHandel(admin, rf.trade_id);
        await send(rf.koeber_id, "sag", {
          titel: "Returkoden kunne ikke laves",
          tekst: `Vi kunne ikke lave en returkode til "${titel}". Du kan prøve igen på handelssiden, eller skrive til BidHamr i sagen. Du betaler ikke returfragten.`,
          link: `/mine-handler/${rf.trade_id}`,
          data: { trade_id: rf.trade_id },
          noegle: `returfragt_daekket_annulleret:${rf.id}`,
        });
      }
    }
    return kode === "ok" ? "annulleret" : kode;
  }
  const { data, error } = await admin.rpc("returfragt_refusion_claim", { p_id: rf.id, p_aarsag: aarsag });
  if (error) throw new Error(`returfragt_refusion_claim: ${error.message}`);
  const kode = String(data);
  if (kode === "staff_afgoer") {
    await markerStaff(
      rf.id,
      "Returfragten skal måske refunderes, men den seneste returkode er annulleret - evt. kun i BidHamr. Staff afgør (Refundér returfragt på sagen).",
    );
    return kode;
  }
  if (kode === "label_findes") {
    await markerStaff(rf.id, "Sagen kræver ikke længere retur, men køberen har en returkode. Vurdér, om returfragten skal refunderes.");
    return kode;
  }
  if (kode !== "ok") return kode;
  await markerStaff(
    rf.id,
    aarsag === "ikke_noedvendig"
      ? "Sagen kræver ikke længere retur: returfragten refunderes automatisk."
      : "Returkoden kunne ikke laves: returfragten refunderes automatisk, og køberen får besked. Hjælp køberen med returen i sagen.",
  );
  return refunderReturfragt(rf.id);
}

// ------------------------------------------------------------------ cron

export type ReturfragtCronResultat = {
  synket: number;
  annulleret: number;
  labels: number;
  refunderet: number;
  fejl: number;
};

// Kaldes fra cron-ruten (hvert minut-job). Label-forsøg er langsomme (DAO op
// til ca. 50 s), så højst LABELS_PR_KOERSEL pr. kørsel og kun inden for
// tidsbudgettet; resten tages næste gang (claimet med label_naeste_kl).
const LABELS_PR_KOERSEL = 2;
const BUDGET_MS = 100_000;

export async function koerReturfragtCron(): Promise<ReturfragtCronResultat | null> {
  const r: ReturfragtCronResultat = { synket: 0, annulleret: 0, labels: 0, refunderet: 0, fejl: 0 };
  const start = Date.now();
  const admin = createAdminClient();
  // Databasen reserverer kun LABELS_PR_KOERSEL label-rækker pr. kørsel.
  const { data, error } = await admin.rpc("returfragt_cron", { p_graense: 20, p_labels: LABELS_PR_KOERSEL });
  if (error) {
    if (manglerTabel(error)) return null;
    throw new Error(`returfragt_cron: ${error.message}`);
  }
  const opgaver = (data ?? []) as { id: string; handling: string }[];
  if (opgaver.length === 0) return r;
  const stripe = getStripe();
  for (const k of opgaver) {
    try {
      const rf = await hentRaekke(admin, k.id);
      if (!rf) continue;
      if (k.handling === "synk" && rf.stripe_payment_intent_id) {
        await spejlReturfragtPi(await stripe.paymentIntents.retrieve(rf.stripe_payment_intent_id));
        r.synket++;
      } else if (k.handling === "annuller") {
        if (rf.stripe_payment_intent_id) {
          const pi = await stripe.paymentIntents.retrieve(rf.stripe_payment_intent_id);
          if (pi.status === "succeeded" || pi.status === "processing") {
            // Nået at blive betalt: spejles - refusionen tager næste kørsel.
            await spejlReturfragtPi(pi);
            continue;
          }
          if (pi.status !== "canceled") {
            await stripe.paymentIntents.cancel(pi.id, {}, { idempotencyKey: `bidhamr-returfragt-annuller-${pi.id}` });
          }
        }
        const { error: aFejl } = await admin.rpc("returfragt_annuller", { p_id: rf.id });
        if (aFejl) throw new Error(`returfragt_annuller: ${aFejl.message}`);
        r.annulleret++;
      } else if (k.handling === "label") {
        // Over budget: tages igen om 15 minutter (reservationen udløber).
        if (Date.now() - start > BUDGET_MS) continue;
        const l = await lavReturlabelEfterBetaling(rf.id, "cron");
        if ("ok" in l) r.labels++;
      } else if (k.handling === "refunder") {
        if ((await claimOgRefunder(admin, rf)) === "refunderet") r.refunderet++;
      } else if (k.handling === "refusion") {
        if ((await refunderReturfragt(rf.id)) === "refunderet") r.refunderet++;
      }
    } catch (err) {
      r.fejl++;
      await logDriftFejl({ kilde: "cron", sti: "returfragt", hvor: `Returfragt: ${k.handling}`, fejl: err });
    }
  }
  return r;
}

// ------------------------------------------------------------------ webhooks: refusion og indsigelse

// refund.failed / refund.updated på en returfragt-refusion: tilbage til
// 'refunderes', så cron'en prøver igen. Svar: kode eller null (ikke vores).
export async function spejlReturfragtRefusionsfejl(refund: Stripe.Refund): Promise<string | null> {
  if (refund.metadata?.type !== RETURFRAGT_TYPE) return null;
  if (refund.status !== "failed" && refund.status !== "canceled") return refund.status ?? "ukendt";
  const { data, error } = await createAdminClient().rpc("returfragt_refusion_fejlet", {
    p_refund: refund.id,
    p_fejl: `Refusionen ${refund.status === "failed" ? "fejlede" : "blev annulleret"} hos Stripe${refund.failure_reason ? ` (${refund.failure_reason})` : ""}`,
  });
  if (error) {
    if (manglerTabel(error)) return null;
    throw new Error(`returfragt_refusion_fejlet: ${error.message}`);
  }
  if (data === "markeret") {
    await alarmPrTilfaelde({
      noegle: `returfragt-refusion-fejlet:${refund.id}`,
      hvor: "betaling/returfragt",
      fejl: `Refusionen ${refund.id} af en returfragt fejlede hos Stripe, efter at køberen har betalt en ny returfragt på handlen. Refundér manuelt i Stripe.`,
    });
  }
  return String(data);
}

// charge.refunded på en returfragt (fx refunderet i Stripe-dashboardet):
// rækken markeres refunderet, så der aldrig laves en returkode bagefter.
// Svar: kode eller null (ikke en returfragt).
export async function spejlReturfragtChargeRefusion(charge: Stripe.Charge): Promise<string | null> {
  const refusioner = (charge.refunds?.data ?? []).filter((r) => r.status !== "failed" && r.status !== "canceled");
  const nyeste = refusioner.sort((a, b) => b.created - a.created)[0]?.id ?? null;
  const { data, error } = await createAdminClient().rpc("returfragt_registrer_charge_refusion", {
    p_charge: charge.id,
    p_refund: nyeste,
    p_fuld: charge.refunded === true,
  });
  if (error) {
    if (manglerTabel(error)) return null;
    throw new Error(`returfragt_registrer_charge_refusion: ${error.message}`);
  }
  const kode = String(data);
  if (kode === "ukendt") return null;
  if (kode === "refunderet" || kode === "allerede") {
    const { data: r } = await createAdminClient()
      .from("returfragt_betalinger")
      .select("id")
      .eq("stripe_charge_id", charge.id)
      .maybeSingle<{ id: string }>();
    if (r) await beskedRefunderet(createAdminClient(), r.id);
  }
  if (kode === "markeret") {
    await alarmPrTilfaelde({
      noegle: `returfragt-delvis:${charge.id}`,
      hvor: "betaling/returfragt",
      fejl: `Returfragtens charge ${charge.id} er delvist refunderet hos Stripe uden om BidHamr. Kontrollér den.`,
    });
  }
  return kode;
}

const STAFF_REFUSION_FEJL: Record<string, string> = {
  ingen_adgang: "Kun admin og chef kan refundere returfragt.",
  inhabil: "Du kan ikke behandle en handel, hvor du selv er køber eller sælger, eller hvor du har handlet med en af dem.",
  begrundelse_mangler: "Skriv en begrundelse.",
  ikke_fundet: "Returfragten findes ikke.",
  forkert_status: "Returfragten er ikke betalt (eller er allerede refunderet).",
  label_findes: "Køberen har en aktiv returkode. Annullér returkoden først.",
  staff_afgoer: "Den seneste returkode er annulleret. Refundér returfragten manuelt.",
  daekket: "Returfragten er betalt af sælgeren eller BidHamr, ikke af køberen - der er intet at refundere.",
  i_gang: "En returkode er ved at blive lavet. Prøv igen om 10 minutter.",
};

// Staff: "Refundér returfragt". staffId SKAL være verificeret (assertRole);
// databasen tjekker rolle og inhabilitet igen og logger i moderation_log.
export async function staffRefunderReturfragt(
  staffId: string,
  rfId: string,
  begrundelse: string,
): Promise<{ ok: true; kode: string } | { fejl: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("returfragt_staff_refusion", {
    p_staff: staffId,
    p_id: rfId,
    p_begrundelse: begrundelse,
  });
  if (error) throw new Error(`returfragt_staff_refusion: ${error.message}`);
  const kode = String(data);
  if (kode !== "ok") return { fejl: STAFF_REFUSION_FEJL[kode] ?? "Noget gik galt. Prøv igen om lidt." };
  // Fejler Stripe-kaldet, prøver cron'en igen (status 'refunderes').
  return { ok: true, kode: await refunderReturfragt(rfId) };
}

// Returfragt-rækken for en charge (indsigelse, afstemning). null = ikke vores.
export async function returfragtForCharge(chargeId: string): Promise<{ id: string; trade_id: string } | null> {
  const { data, error } = await createAdminClient()
    .from("returfragt_betalinger")
    .select("id, trade_id")
    .eq("stripe_charge_id", chargeId)
    .maybeSingle<{ id: string; trade_id: string }>();
  if (error) return null;
  return data;
}

// ------------------------------------------------------------------ visning

export type MinReturfragt = {
  rolle: "koeber";
  sag: { kode: string; til_kl?: string | null };
  id: string | null;
  status: ReturfragtRaekke["status"] | null;
  beloeb_oere: number | null;
  betalt_kl: string | null;
  label_klar: boolean;
  label_fejl: string | null;
  refunderet_kl: string | null;
  refusion_aarsag: string | null;
};
