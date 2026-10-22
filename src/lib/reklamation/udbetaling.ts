import "server-only";

// Chefens udbetaling af en reklamation (fragtfirmaets erstatning) til
// sælgeren (ROADMAP-BESLUTNINGER afsnit 4, Filip 22. okt. 2026; migration
// 20261029010000_reklamation_fragtfirma.sql).
//
// Pengene: fragtfirmaet (DAO/GLS) udbetaler erstatningen til BidHamr (bank
// eller modregnet på fakturaen) - uden om Stripe. Når chefen har bekræftet
// det, flyttes HELE det godkendte beløb i to trin:
//   1. Stripe Transfer fra BidHamrs platformssaldo (available, kort) til
//      sælgerens Connect-konto (destination = kontoen fra betalingen),
//      transfer_group = handlens (handel_<trade>), metadata
//      type=reklamation. Idempotency key
//      bidhamr-reklamation-transfer-<reklamation>-<forsøg> (forsøg tælles kun
//      op, når Stripe med sikkerhed IKKE har lavet en transfer).
//   2. Payout fra sælgerens Connect-konto til sælgerens bank (sælgerkonti
//      har manuel udbetalingsplan - kun BidHamr udbetaler), metadata
//      type=reklamation, idempotency key
//      bidhamr-reklamation-payout-<reklamation>-<forsøg>. En egen payout - ikke
//      en del af de almindelige udbetalinger (saelger_udbetalinger), som
//      kun summerer handler og er bundet til hver betalings charge (F03).
//      Webhooken (payout.*) og afstemningen genkender den på metadata/id, så
//      den aldrig regnes som en fremmed udbetaling.
// BidHamr beholder intet; der er ingen saldo/wallet. Erstatningen er ikke
// BidHamrs indtægt, så der laves ingen faktura (docs/FRAGT.md).
//
// Værn som de andre udbetalinger: nødstop og frosset sælger (databasen +
// frisk tjek lige før Stripe), sælgerens konto skal kunne modtage
// (transfers aktiv, udbetalinger aktive, manuel plan, ingen negativ saldo),
// BidHamrs saldo skal dække beløbet, og et usikkert svar fra Stripe slås op
// (metadata) før nyt forsøg.

import Stripe from "stripe";
import { getStripe, StripeTilstandFejl } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { alarmPrTilfaelde, lukTilfaelde } from "@/lib/betaling/driftTilfaelde";
import { hentNoedstop } from "@/lib/betaling/noedstop";
import { dkk } from "@/lib/betaling/udbetaling";
import { transportoerNavn, type StaffReklamation } from "@/lib/reklamation/typer";

type Admin = ReturnType<typeof createAdminClient>;

const KALD: Stripe.RequestOptions = { timeout: 30_000, maxNetworkRetries: 1 };
// Et kald, der er sendt for nylig, kan stadig være i gang hos Stripe.
const I_GANG_MS = 10 * 60_000;
// Stripes idempotency-nøgler udløber efter 24 timer.
const NOEGLE_LEVETID_MS = 23 * 60 * 60_000;

export const REKLAMATION_METADATA_TYPE = "reklamation";

export function transferNoegle(id: string, forsoeg: number): string {
  return `bidhamr-reklamation-transfer-${id}-${forsoeg}`;
}

export function payoutNoegle(id: string, forsoeg: number): string {
  return `bidhamr-reklamation-payout-${id}-${forsoeg}`;
}

export function transferGruppe(tradeId: string): string {
  return `handel_${tradeId}`;
}

function stripeId(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

// Stripe afviste med sikkerhed (ingen transfer/payout er lavet).
function erEndelig(err: unknown): boolean {
  return (
    err instanceof StripeTilstandFejl ||
    (err instanceof Stripe.errors.StripeError &&
      (err instanceof Stripe.errors.StripeInvalidRequestError ||
        err instanceof Stripe.errors.StripePermissionError ||
        err instanceof Stripe.errors.StripeCardError) &&
      !(err instanceof Stripe.errors.StripeIdempotencyError))
  );
}

function fejlKode(err: unknown): string {
  if (err instanceof StripeTilstandFejl) return "stripe_stoppet";
  if (err instanceof Stripe.errors.StripeError) return String(err.code ?? err.type ?? "stripe_fejl").slice(0, 60);
  return "ukendt_fejl";
}

// ------------------------------------------------------------------ trin 1

export type UdbetalClaim = {
  beloeb_oere: number;
  konto: string;
  forsoeg: number;
  trade_id: string;
  sag_id: string;
  saelger_id: string;
  sagsnummer: string | null;
  transportoer: string;
  genoptag: boolean;
  paabegyndt_kl: string;
};

export type TransferResultat =
  | "udbetalt"
  | "stoppet"
  | "frosset"
  | "konto_ikke_klar"
  | "saelger_saldo_negativ"
  | "platform_saldo"
  | "afvist"
  | "usikker"
  | "proev_igen"
  | "afviger";

// Frigør claimen (Stripe har med sikkerhed ikke lavet en transfer).
async function frigiv(admin: Admin, id: string, tekst: string): Promise<void> {
  const { error } = await admin.rpc("fragt_reklamation_udbetal_afvist", { p_reklamation: id, p_fejl: tekst, p_frigiv: true });
  if (error) throw new Error(`fragt_reklamation_udbetal_afvist: ${error.message}`);
}

async function usikker(admin: Admin, id: string, tekst: string): Promise<void> {
  const { error } = await admin.rpc("fragt_reklamation_udbetal_afvist", { p_reklamation: id, p_fejl: tekst, p_frigiv: false });
  if (error) console.error("fragt_reklamation_udbetal_afvist (usikker):", error.message);
}

// Findes transferen allerede (svaret gik tabt)? Slås op via metadata.
async function findTransfer(stripe: Stripe, id: string, c: { konto: string; trade_id: string; paabegyndt_kl: string }) {
  const fra = Math.floor(new Date(c.paabegyndt_kl).getTime() / 1000) - 3600;
  for await (const t of stripe.transfers.list(
    { destination: c.konto, transfer_group: transferGruppe(c.trade_id), created: { gte: fra }, limit: 100 },
    KALD,
  )) {
    if (t.metadata?.type === REKLAMATION_METADATA_TYPE && t.metadata?.reklamation_id === id) return t;
  }
  return null;
}

async function registrerTransfer(admin: Admin, id: string, c: UdbetalClaim, t: Stripe.Transfer): Promise<TransferResultat> {
  const destination = stripeId(t.destination as string | { id: string } | null);
  if (Number(t.amount) !== Number(c.beloeb_oere) || t.currency !== "dkk" || destination !== c.konto) {
    await logDriftFejl({
      kilde: "server",
      hvor: "reklamation/udbetaling",
      fejl: `Reklamation ${id}: Stripe-transfer ${t.id} har et andet beløb, en anden valuta eller en anden konto end chefens udbetaling. Udbetalingen er IKKE registreret - kontrollér transferen i Stripe.`,
      brugerId: c.saelger_id,
    });
    return "afviger";
  }
  const { data, error } = await admin.rpc("fragt_reklamation_udbetal_registrer", {
    p_reklamation: id,
    p_transfer: t.id,
    p_beloeb_oere: Number(t.amount),
    p_konto: destination,
  });
  if (error) throw new Error(`fragt_reklamation_udbetal_registrer: ${error.message}`);
  const svar = String(data);
  if (svar === "ok" || svar === "allerede") {
    await lukTilfaelde(`reklamation-transfer-haenger:${id}`);
    return "udbetalt";
  }
  await logDriftFejl({
    kilde: "server",
    hvor: "reklamation/udbetaling",
    fejl: `Reklamation ${id}: Stripe-transfer ${t.id} er lavet, men kunne ikke registreres (${svar}). Kontrollér reklamationen og transferen i Stripe.`,
    brugerId: c.saelger_id,
  });
  return "afviger";
}

// Laver transferen for en claim fra fragt_reklamation_udbetal_claim (chefens
// session har allerede tjekket rolle, aal2, inhabilitet, bekræftelse,
// betingelser, nødstop, frysning og konto). Kaster ved uventede fejl
// (claimen beholdes så - næste forsøg slår op først).
export async function udfoerReklamationTransfer(id: string, c: UdbetalClaim): Promise<TransferResultat> {
  const admin = createAdminClient();
  const stripe = getStripe();
  // Stop før Stripe-kaldet. Er et tidligere kald (måske) nået frem
  // (genoptag), beholdes claimen, så næste forsøg bruger samme nøgle - ellers
  // frigøres den (intet er sendt til Stripe).
  const stopFoer = (tekst: string) => (c.genoptag ? usikker(admin, id, tekst) : frigiv(admin, id, tekst));

  // Et tidligere forsøg uden svar: findes transferen allerede?
  if (c.genoptag) {
    const fundet = await findTransfer(stripe, id, c);
    if (fundet) return registrerTransfer(admin, id, c, fundet);
    // Nøglen kan stadig være gemt hos Stripe (under 24 t) - samme nøgle
    // bruges igen. Er den udløbet, frigøres claimen, og chefen trykker igen
    // (ny nøgle) - transferen findes med sikkerhed ikke (opslaget ovenfor).
    if (Date.now() - new Date(c.paabegyndt_kl).getTime() > NOEGLE_LEVETID_MS) {
      await frigiv(admin, id, "Ingen transfer fundet hos Stripe efter et usikkert svar - prøv igen");
      return "proev_igen";
    }
  }

  // Sidste tjek lige før Stripe: nødstop eller frysning sat efter claimen.
  if ((await hentNoedstop(true)).udbetalingerStoppet) {
    await stopFoer("Nødstop: udbetalinger er stoppet");
    return "stoppet";
  }
  const { data: profil, error: pFejl } = await admin
    .from("betalingsprofiler")
    .select("udbetaling_frosset_kl, stripe_account_id, connect_frakoblet_kl")
    .eq("user_id", c.saelger_id)
    .maybeSingle<{ udbetaling_frosset_kl: string | null; stripe_account_id: string | null; connect_frakoblet_kl: string | null }>();
  if (pFejl) throw new Error(`betalingsprofiler: ${pFejl.message}`);
  if (profil?.udbetaling_frosset_kl) {
    await stopFoer("Sælgerens udbetalinger er frosset");
    return "frosset";
  }
  if (!profil || profil.stripe_account_id !== c.konto || profil.connect_frakoblet_kl) {
    await stopFoer("Sælgerens Stripe-konto er skiftet eller frakoblet");
    return "konto_ikke_klar";
  }

  // Sælgerens konto skal kunne modtage og udbetale.
  let konto: Stripe.Account;
  try {
    konto = await stripe.accounts.retrieve(c.konto, undefined, KALD);
  } catch (err) {
    if (err instanceof Stripe.errors.StripePermissionError) {
      await stopFoer("Ingen adgang til sælgerens Stripe-konto");
      return "konto_ikke_klar";
    }
    throw err;
  }
  if (konto.capabilities?.transfers !== "active" || !konto.payouts_enabled) {
    await stopFoer("Sælgerens Stripe-konto kan ikke modtage penge lige nu (transfers/udbetalinger ikke aktive)");
    return "konto_ikke_klar";
  }
  const saelgerSaldo = await stripe.balance.retrieve({}, { ...KALD, stripeAccount: c.konto });
  if (dkk(saelgerSaldo.available, false) + dkk(saelgerSaldo.pending, false) < 0) {
    // Et underskud på kontoen (fx efter en refusion) ville "spise" erstatningen.
    await stopFoer("Sælgerens Stripe-konto har en negativ saldo");
    return "saelger_saldo_negativ";
  }

  // BidHamrs platformssaldo skal dække beløbet (transfers uden
  // source_transaction trækkes fra den tilgængelige saldo - kort).
  const platform = await stripe.balance.retrieve({}, KALD);
  if (dkk(platform.available, true) < Number(c.beloeb_oere)) {
    await stopFoer("Der er ikke nok penge på BidHamrs Stripe-saldo");
    return "platform_saldo";
  }

  let transfer: Stripe.Transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount: Number(c.beloeb_oere),
        currency: "dkk",
        destination: c.konto,
        transfer_group: transferGruppe(c.trade_id),
        description: `BidHamr: erstatning fra ${transportoerNavn(c.transportoer)} (reklamation)`,
        metadata: {
          type: REKLAMATION_METADATA_TYPE,
          reklamation_id: id,
          trade_id: c.trade_id,
          sag_id: c.sag_id,
          saelger_id: c.saelger_id,
          transportoer: c.transportoer,
          transportoer_sagsnummer: (c.sagsnummer ?? "").slice(0, 100),
        },
      },
      { ...KALD, idempotencyKey: transferNoegle(id, c.forsoeg) },
    );
  } catch (err) {
    const kode = fejlKode(err);
    if (erEndelig(err)) {
      await frigiv(admin, id, `Stripe afviste udbetalingen (${kode})`);
      if (kode === "balance_insufficient") return "platform_saldo";
      await logDriftFejl({
        kilde: "server",
        hvor: "reklamation/udbetaling",
        fejl: `Reklamation ${id}: Stripe afviste transferen til sælgerens konto (${kode}). Ingen penge er flyttet.`,
        brugerId: c.saelger_id,
      });
      return "afvist";
    }
    await usikker(admin, id, `Usikkert svar fra Stripe (${kode}) - slås op før nyt forsøg`);
    await alarmPrTilfaelde({
      noegle: `reklamation-transfer-haenger:${id}`,
      hvor: "reklamation/udbetaling",
      fejl: `Reklamation ${id}: usikkert svar fra Stripe på transferen (${kode}). Det er uvist, om pengene er sendt - cron'en slår den op; chefen kan trykke "Udbetal" igen (samme nøgle, ingen dobbelt udbetaling).`,
      brugerId: c.saelger_id,
    });
    return "usikker";
  }
  return registrerTransfer(admin, id, c, transfer);
}

// ------------------------------------------------------------------ trin 2

export type BankResultat =
  | "oprettet"
  | "faerdig"
  | "ikke_udbetalt"
  | "i_gang"
  | "stoppet"
  | "frosset"
  | "venter_paa_bank"
  | "konto_ikke_klar"
  | "venter_saldo"
  | "afvist"
  | "usikker"
  | "ikke_fundet";

async function hentRaekke(admin: Admin, id: string): Promise<StaffReklamation | null> {
  const { data, error } = await admin.from("fragt_reklamationer").select("*").eq("id", id).maybeSingle<StaffReklamation>();
  if (error) throw new Error(`fragt_reklamationer: ${error.message}`);
  return data;
}

async function findPayout(stripe: Stripe, r: StaffReklamation): Promise<Stripe.Payout | null> {
  const fra = Math.floor(new Date(r.bank_claimet_kl ?? r.udbetalt_kl ?? Date.now()).getTime() / 1000) - 3600;
  for await (const p of stripe.payouts.list(
    { created: { gte: fra }, limit: 100 },
    { ...KALD, stripeAccount: r.udbetaling_stripe_konto! },
  )) {
    if (p.metadata?.type === REKLAMATION_METADATA_TYPE && p.metadata?.reklamation_id === r.id) return p;
  }
  return null;
}

// Spejler en payout (hentet frisk hos Stripe) på reklamationen.
async function spejl(admin: Admin, r: StaffReklamation, konto: string, p: Stripe.Payout): Promise<string> {
  const bank = stripeId(p.destination as string | { id: string } | null);
  const { data, error } = await admin.rpc("fragt_reklamation_bank_spejl", {
    p_reklamation: r.id,
    p_konto: konto,
    p_payout: p.id,
    p_status: p.status,
    p_fejlkode: p.failure_code ?? null,
    p_bank: bank,
  });
  if (error) throw new Error(`fragt_reklamation_bank_spejl: ${error.message}`);
  const svar = (data ?? {}) as { kode?: string; fra?: string | null; til?: string };
  if (svar.kode === "ok" && svar.til === "paid") await lukTilfaelde(`reklamation-bank-saldo:${r.id}`);
  if (svar.kode === "ok" && (svar.til === "failed" || svar.til === "canceled")) {
    const { markerUdbetalingskonto } = await import("@/lib/betaling/stripeBetaling");
    if (svar.til === "failed") {
      await markerUdbetalingskonto(
        konto,
        `Udbetaling af en erstatning (reklamation) til sælgerens bank fejlede hos Stripe (${p.failure_code ?? "ukendt årsag"}, ${p.id}). Nye udbetalinger venter, til sælgeren har rettet sin bankkonto hos Stripe.`,
      );
    }
    await logDriftFejl({
      kilde: "server",
      hvor: "reklamation/bank",
      fejl: `Reklamation ${r.id}: udbetalingen af erstatningen (${p.id}) til sælgerens bank er ${svar.til === "failed" ? "fejlet" : "annulleret"} hos Stripe (${p.failure_code ?? "ukendt"}). Pengene er tilbage på sælgerens Stripe-konto${svar.til === "failed" ? " og sendes igen, når sælgeren har rettet bankkontoen" : " - kontrollér i Stripe"}.`,
      brugerId: r.saelger_id,
    });
  }
  return String(svar.kode ?? "ukendt");
}

// Sender den udbetalte erstatning videre fra sælgerens Connect-konto til
// sælgerens bank. Idempotent; kaster ved uventede fejl.
export async function udbetalReklamationTilBank(id: string): Promise<BankResultat> {
  const admin = createAdminClient();
  const stripe = getStripe();
  const r = await hentRaekke(admin, id);
  if (!r) return "ikke_fundet";
  if (r.status !== "udbetalt" || !r.stripe_transfer_id || !r.udbetaling_stripe_konto) return "ikke_udbetalt";
  if (r.bank_status === "oprettet" || r.bank_status === "paid" || r.bank_status === "canceled") return "faerdig";
  const konto = r.udbetaling_stripe_konto;

  let nyNoegle = false;
  if (r.bank_status === "claimet") {
    const sidst = r.bank_sidst_sendt_kl ? new Date(r.bank_sidst_sendt_kl).getTime() : 0;
    if (Date.now() - sidst < I_GANG_MS) return "i_gang";
    const fundet = await findPayout(stripe, r);
    if (fundet) {
      await spejl(admin, r, konto, fundet);
      return "oprettet";
    }
    nyNoegle = Date.now() - sidst > NOEGLE_LEVETID_MS;
  }

  if ((await hentNoedstop(true)).udbetalingerStoppet) return "stoppet";

  let acc: Stripe.Account;
  try {
    acc = await stripe.accounts.retrieve(konto, undefined, KALD);
  } catch (err) {
    if (err instanceof Stripe.errors.StripePermissionError) return "konto_ikke_klar";
    throw err;
  }
  if (!acc.payouts_enabled || acc.settings?.payouts?.schedule?.interval !== "manual") return "konto_ikke_klar";

  const saldo = await stripe.balance.retrieve({}, { ...KALD, stripeAccount: konto });
  if (dkk(saldo.available, true) < Number(r.godkendt_beloeb_oere)) {
    if (r.udbetalt_kl && Date.now() - new Date(r.udbetalt_kl).getTime() > 3600_000) {
      await alarmPrTilfaelde({
        noegle: `reklamation-bank-saldo:${r.id}`,
        hvor: "reklamation/bank",
        fejl: `Reklamation ${r.id}: sælgerens Stripe-konto ${konto} har ikke nok tilgængelige midler til at sende erstatningen videre til banken. Prøves igen automatisk - kontrollér saldoen i Stripe.`,
        brugerId: r.saelger_id,
      });
    }
    return "venter_saldo";
  }

  const { data: start, error: sFejl } = await admin.rpc("fragt_reklamation_bank_start", {
    p_reklamation: r.id,
    p_ny_noegle: nyNoegle,
  });
  if (sFejl) throw new Error(`fragt_reklamation_bank_start: ${sFejl.message}`);
  const s = (start ?? {}) as { kode?: string; forsoeg?: number; beloeb_oere?: number; konto?: string };
  if (s.kode !== "ok") return (s.kode === "faerdig" ? "faerdig" : (s.kode as BankResultat)) ?? "afvist";
  if (s.konto !== konto || Number(s.beloeb_oere) !== Number(r.godkendt_beloeb_oere)) {
    await admin.rpc("fragt_reklamation_bank_fejl", { p_reklamation: r.id, p_fejl: "Konto/beløb passer ikke", p_frigiv: true });
    return "afvist";
  }

  let payout: Stripe.Payout;
  try {
    payout = await stripe.payouts.create(
      {
        amount: Number(s.beloeb_oere),
        currency: "dkk",
        description: "BidHamr: erstatning (reklamation)",
        metadata: {
          type: REKLAMATION_METADATA_TYPE,
          reklamation_id: r.id,
          trade_id: r.trade_id,
          saelger_id: r.saelger_id,
        },
      },
      { ...KALD, stripeAccount: konto, idempotencyKey: payoutNoegle(r.id, Number(s.forsoeg ?? 0)) },
    );
  } catch (err) {
    const kode = fejlKode(err);
    if (erEndelig(err)) {
      await admin.rpc("fragt_reklamation_bank_fejl", {
        p_reklamation: r.id,
        p_fejl: `Stripe afviste udbetalingen til banken (${kode})`,
        p_frigiv: true,
      });
      await logDriftFejl({
        kilde: "server",
        hvor: "reklamation/bank",
        fejl: `Reklamation ${r.id}: Stripe afviste udbetalingen af erstatningen til sælgerens bank (${kode}). Prøves igen automatisk.`,
        brugerId: r.saelger_id,
      });
      return "afvist";
    }
    await admin.rpc("fragt_reklamation_bank_fejl", {
      p_reklamation: r.id,
      p_fejl: `Usikkert svar fra Stripe (${kode}) - slås op før nyt forsøg`,
      p_frigiv: false,
    });
    await logDriftFejl({
      kilde: "server",
      hvor: "reklamation/bank",
      fejl: `Reklamation ${r.id}: usikkert svar fra Stripe på udbetalingen til sælgerens bank (${kode}). Slås op og prøves igen automatisk.`,
      brugerId: r.saelger_id,
    });
    return "usikker";
  }
  const efter = (await hentRaekke(admin, r.id)) ?? r;
  await spejl(admin, efter, konto, payout);
  return "oprettet";
}

// ------------------------------------------------------------------ webhook

// payout.* på en sælgerkonto: er det en reklamations-payout? Svar: null =
// ikke en reklamation (spejlUdbetaling går videre til "fremmed"). Payouten er
// hentet frisk af kalderen. Metadata stoles kun på, hvis reklamationen hører
// til samme konto.
export async function spejlReklamationPayout(konto: string, payout: Stripe.Payout): Promise<string | null> {
  const admin = createAdminClient();
  const { data: kendt } = await admin
    .from("fragt_reklamationer")
    .select("*")
    .eq("bank_payout_id", payout.id)
    .maybeSingle<StaffReklamation>();
  let r = kendt ?? null;
  const mdId = payout.metadata?.type === REKLAMATION_METADATA_TYPE ? payout.metadata?.reklamation_id : null;
  if (!r && mdId && /^[0-9a-f-]{36}$/i.test(mdId)) r = await hentRaekke(admin, mdId.toLowerCase());
  if (!r || r.udbetaling_stripe_konto !== konto) return null;
  if (Number(payout.amount) !== Number(r.godkendt_beloeb_oere)) {
    await alarmPrTilfaelde({
      noegle: `reklamation-payout-afviger:${payout.id}`,
      hvor: "reklamation/bank",
      fejl: `Payout ${payout.id} på sælgerkonto ${konto} er mærket som reklamation ${r.id}, men beløbet passer ikke. Kontrollér i Stripe.`,
      brugerId: r.saelger_id,
    });
    return "reklamation_afviger";
  }
  return `reklamation_${await spejl(admin, r, konto, payout)}`;
}

// transfer.reversed / transfer.updated (platform): en reklamations-transfer
// er tilbageført hos Stripe. BidHamr gør det aldrig selv - drift-alarm.
// null = ikke en reklamation.
export async function spejlReklamationTransfer(t: Stripe.Transfer): Promise<string | null> {
  if (!(Number(t.amount_reversed) > 0) && !t.reversed) return null;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fragt_reklamation_transfer_tilbagefoert", { p_transfer: t.id });
  if (error) {
    if (["PGRST202", "42883"].includes(error.code ?? "")) return null;
    throw new Error(`fragt_reklamation_transfer_tilbagefoert: ${error.message}`);
  }
  if (!data) return null;
  await alarmPrTilfaelde({
    noegle: `reklamation-transfer-tilbagefoert:${t.id}`,
    hvor: "reklamation/udbetaling",
    fejl: `Stripe-transfer ${t.id} (erstatning til en sælger, reklamation ${String(data)}) er tilbageført hos Stripe - ikke af BidHamr. Kontrollér i Stripe.`,
  });
  return "reklamation_tilbagefoert";
}

// ------------------------------------------------------------------ cron

// Betalings-cron'en (og webhooken for én sælger - balance.available,
// bankkonto rettet): erstatninger, der mangler at blive sendt videre til
// banken, payouts uden event i 2 døgn, og transfers med et usikkert svar.
// Kaster aldrig. Svar: antal sendt/afklaret.
export async function udbetalReklamationerTilBank(saelgerId?: string): Promise<number> {
  let antal = 0;
  try {
    const admin = createAdminClient();
    let q = admin
      .from("fragt_reklamationer")
      .select("id, saelger_id")
      .eq("status", "udbetalt")
      .or("bank_status.is.null,bank_status.eq.claimet,bank_status.eq.failed")
      .order("udbetalt_kl", { ascending: true })
      .limit(50);
    if (saelgerId) q = q.eq("saelger_id", saelgerId);
    const { data, error } = await q;
    if (error) {
      if (!["42P01", "PGRST205", "42703", "PGRST204"].includes(error.code ?? "")) {
        await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Reklamation: udbetaling til bank", fejl: error });
      }
      return 0;
    }
    for (const r of data ?? []) {
      try {
        const res = await udbetalReklamationTilBank(r.id as string);
        if (res === "oprettet") antal++;
      } catch (err) {
        await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Reklamation: udbetaling til bank", fejl: err, brugerId: r.saelger_id as string });
      }
    }
    if (saelgerId) return antal;

    // Payouts uden event i 2 døgn: slås op hos Stripe.
    const { data: gamle } = await admin
      .from("fragt_reklamationer")
      .select("*")
      .eq("status", "udbetalt")
      .eq("bank_status", "oprettet")
      .lt("bank_oprettet_kl", new Date(Date.now() - 2 * 24 * 3600_000).toISOString())
      .limit(20);
    for (const r of (gamle ?? []) as StaffReklamation[]) {
      try {
        const p = await getStripe().payouts.retrieve(r.bank_payout_id!, undefined, { ...KALD, stripeAccount: r.udbetaling_stripe_konto! });
        if (p.status !== "pending" && p.status !== "in_transit") {
          await spejl(admin, r, r.udbetaling_stripe_konto!, p);
          antal++;
        }
      } catch (err) {
        await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Reklamation: opfølgning på udbetaling", fejl: err, brugerId: r.saelger_id });
      }
    }

    // Transfers med et usikkert svar (påbegyndt for over 10 min. siden):
    // findes den hos Stripe, registreres den; ellers én alarm til chefen.
    const { data: haenger } = await admin
      .from("fragt_reklamationer")
      .select("*")
      .eq("status", "godkendt")
      .not("udbetaling_paabegyndt_kl", "is", null)
      .lt("udbetaling_paabegyndt_kl", new Date(Date.now() - I_GANG_MS).toISOString())
      .limit(20);
    for (const r of (haenger ?? []) as StaffReklamation[]) {
      try {
        const c = {
          konto: r.udbetaling_stripe_konto!,
          trade_id: r.trade_id,
          paabegyndt_kl: r.udbetaling_paabegyndt_kl!,
        };
        const t = await findTransfer(getStripe(), r.id, c);
        if (t) {
          const res = await registrerTransfer(admin, r.id, {
            ...c,
            beloeb_oere: Number(r.godkendt_beloeb_oere),
            forsoeg: r.udbetaling_forsoeg,
            sag_id: r.sag_id,
            saelger_id: r.saelger_id,
            sagsnummer: r.transportoerens_sagsnummer,
            transportoer: r.transportoer,
            genoptag: true,
          }, t);
          if (res === "udbetalt") {
            antal++;
            await udbetalReklamationTilBank(r.id);
          }
          continue;
        }
        await alarmPrTilfaelde({
          noegle: `reklamation-transfer-haenger:${r.id}`,
          hvor: "reklamation/udbetaling",
          fejl: `Reklamation ${r.id}: chefens udbetaling er sat i gang, men Stripe har ingen transfer. Chefen skal trykke "Udbetal til sælger" igen (samme nøgle - ingen dobbelt udbetaling).`,
          brugerId: r.saelger_id,
        });
      } catch (err) {
        await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Reklamation: uafklaret udbetaling", fejl: err, brugerId: r.saelger_id });
      }
    }
  } catch (err) {
    await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Reklamation: udbetaling til bank", fejl: err });
  }
  return antal;
}
