import "server-only";

// Betalingsmodel trin 4: indsigelser (disputes) på destination-betalinger
// (docs/BETALINGSMODEL-PLAN.md 1.6 og 6.4, migration 20261011040000).
//
// På destination charges trækkes en indsigelse fra PLATFORMEN (BidHamr),
// mens købers penge står på sælgerens Stripe Connect-konto.
//   - Åben indsigelse FØR udbetaling: pengene fryses (trin 3's blokering -
//     betaling_udbetaling_blokeret 'indsigelse'). BidHamr lægger beviserne klar
//     hos Stripe (sporing, datoer, varen) - staff gennemser og indsender dem.
//   - Vundet: handlen fortsætter (spejlIndsigelse prøver udbetalingen).
//   - TABT før udbetaling (Filip 8. okt. 2026): køberen har fået pengene af
//     banken, køberen sender varen tilbage til sælgeren, sælgeren får varen
//     igen og INGEN udbetaling. BidHamr henter beløbet tilbage fra sælgerens
//     konto (transfer reversal af højst udbetaling_oere og højst det omstridte
//     beløb), så BidHamr ikke bærer tabet. BidHamrs gebyr er allerede på
//     platformen, så platformen står lige (Stripes indsigelsesgebyr undtaget).
//   - TABT efter udbetaling (handlen var helt færdig): BidHamr bærer tabet -
//     INTET trækkes fra sælgeren. Køberen skal sende varen til BidHamr.
// Tilbageførslen prøves igen med spredte forsøg (5 min, 10 min ... højst 6 t)
// af betalings-cron'en; efter 5 forsøg markeres betalingen til staff, som kan
// trykke "Hent beløbet fra sælgeren igen". Sælgerens saldo må aldrig blive
// negativ af BidHamrs tilbageførsel: saldoen tjekkes først.
//
// I separat-modellen ændres intet (alt her kræver pengemodel 'destination').

import Stripe from "stripe";
import { getStripe, StripeTilstandFejl } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { send } from "@/lib/notifikationer/send";
import { sendIndsigelseTilSaelger } from "@/lib/betaling/indsigelseBeskeder";

type Admin = ReturnType<typeof createAdminClient>;
const KALD: Stripe.RequestOptions = { timeout: 20_000, maxNetworkRetries: 1 };

type Raekke = {
  id: string;
  trade_id: string;
  auction_id: string;
  buyer_id: string;
  seller_id: string;
  pengemodel: string;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  stripe_dispute_id: string | null;
  indsigelse_status: string | null;
  indsigelse_beviser_kl: string | null;
  saelger_udbetaling_id: string | null;
  overfoersel_paabegyndt_kl: string | null;
  betalt_kl: string | null;
  frigivet_kl: string | null;
};

const KOLONNER =
  "id, trade_id, auction_id, buyer_id, seller_id, pengemodel, stripe_payment_intent_id, stripe_charge_id, stripe_dispute_id, indsigelse_status, indsigelse_beviser_kl, saelger_udbetaling_id, overfoersel_paabegyndt_kl, betalt_kl, frigivet_kl";

function manglerIDatabasen(err: { code?: string } | null): boolean {
  return !!err && ["PGRST202", "PGRST204", "42883", "42703"].includes(err.code ?? "");
}

async function marker(admin: Admin, betalingId: string, tekst: string): Promise<void> {
  const { error } = await admin.rpc("betaling_marker_refusion", { p_betaling: betalingId, p_besked: tekst });
  if (error) console.error("Markering (indsigelse) fejlede:", betalingId, error.message);
}

function isoDag(kl: string | null | undefined): string | null {
  return kl ? new Date(kl).toISOString().slice(0, 10) : null;
}

// ------------------------------------------------------------------ webhook

// Kaldes af spejlIndsigelse efter hver dispute-hændelse (resultat fra
// betaling_registrer_indsigelse). Kaster aldrig - spejlingen må ikke fejle.
export async function efterIndsigelseDestination(d: Stripe.Dispute, resultat: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const piId = typeof d.payment_intent === "string" ? d.payment_intent : (d.payment_intent?.id ?? null);
    const chId = typeof d.charge === "string" ? d.charge : d.charge.id;
    let q = admin.from("betalinger").select(KOLONNER).limit(1);
    q = piId ? q.eq("stripe_payment_intent_id", piId) : q.eq("stripe_charge_id", chId);
    const { data: b, error } = await q.maybeSingle<Raekke>();
    if (error) {
      if (!manglerIDatabasen(error)) throw new Error(error.message);
      return;
    }
    if (!b || b.pengemodel !== "destination") return;

    // Svarfristen gemmes (varsler 48 og 12 timer før - varslIndsigelsesfrister).
    const frist = d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000).toISOString() : null;
    if (frist) {
      const { error: fFejl } = await admin.from("betalinger").update({ indsigelse_frist_kl: frist }).eq("id", b.id);
      if (fFejl && !manglerIDatabasen(fFejl)) console.error("indsigelse_frist_kl:", b.id, fFejl.message);
    }

    if (resultat === "blokeret") {
      await forberedBeviser(admin, b, d);
      return;
    }
    if (resultat === "tabt") {
      // Køberen får besked i tilbagefoerVedTabtIndsigelse, når det er afgjort,
      // om handlen var udbetalt (ellers af betalings-cron senere).
      await tilbagefoerVedTabtIndsigelse(b.id, d);
    }
  } catch (err) {
    console.error("efterIndsigelseDestination fejlede:", d.id, err);
    await logDriftFejl({ kilde: "server", hvor: "betaling/indsigelse", fejl: err });
  }
}

// Beviserne lægges klar på indsigelsen hos Stripe (submit: false - staff
// gennemser og indsender dem i Stripe; chefens valg, så intet sendes til
// banken uden et menneske). Kun én gang pr. betaling, og kun når Stripe
// venter på svar og intet er lagt ind endnu.
async function forberedBeviser(admin: Admin, b: Raekke, d: Stripe.Dispute): Promise<void> {
  if (b.indsigelse_beviser_kl) return;
  if (!["needs_response", "warning_needs_response"].includes(d.status)) return;
  if (d.evidence_details?.has_evidence || Number(d.evidence_details?.submission_count ?? 0) > 0) return;

  const [{ data: h }, { data: a }] = await Promise.all([
    admin
      .from("trades")
      .select("status, tracking_number, sendt_kl, received_at, afhentning, created_at")
      .eq("id", b.trade_id)
      .maybeSingle(),
    admin.from("auctions").select("titel").eq("id", b.auction_id).maybeSingle(),
  ]);
  const titel = ((a?.titel as string | undefined) ?? "Vare").slice(0, 200);
  const afhentning = !!h?.afhentning;
  const linjer = [
    `Handel på BidHamr (bidhamr.dk), en dansk auktionsplatform for brugte ting mellem private. Handel-id: ${b.trade_id}.`,
    `Varen: "${titel}", vundet på auktion og betalt af køberen ${isoDag(b.betalt_kl) ?? "(ukendt dato)"}.`,
    afhentning
      ? `Levering: afhentning hos sælgeren${h?.received_at ? `, udleveret mod købers personlige kode ${isoDag(h.received_at as string)}` : ""}.`
      : h?.sendt_kl || h?.tracking_number
        ? `Levering: sendt med GLS${h?.tracking_number ? ` (sporingsnummer ${h.tracking_number})` : ""}${h?.sendt_kl ? ` ${isoDag(h.sendt_kl as string)}` : ""}${h?.received_at ? `, modtaget ${isoDag(h.received_at as string)}` : ""}.`
        : "Levering: varen er endnu ikke sendt.",
    b.frigivet_kl ? `Køberen godkendte varen, eller fristen for at klage udløb uden klage, ${isoDag(b.frigivet_kl)}.` : "",
    "BidHamr har beskeder, billeder og sporing fra handlen og sender dem gerne.",
  ].filter(Boolean);

  const evidence: Stripe.DisputeUpdateParams.Evidence = {
    product_description: `Brugt vare solgt på auktion på bidhamr.dk: "${titel}".`,
    uncategorized_text: linjer.join("\n").slice(0, 19_000),
  };
  if (!afhentning && h?.tracking_number) {
    evidence.shipping_tracking_number = String(h.tracking_number).slice(0, 200);
    evidence.shipping_carrier = "GLS";
  }
  if (!afhentning && h?.sendt_kl) evidence.shipping_date = isoDag(h.sendt_kl as string) ?? undefined;

  await getStripe().disputes.update(
    d.id,
    { evidence, submit: false, metadata: { betaling_id: b.id, beviser: "forberedt_af_bidhamr" } },
    KALD,
  );
  await admin.rpc("betaling_indsigelse_beviser_registrer", { p_betaling: b.id });
  await marker(
    admin,
    b.id,
    // Ingen tal i teksten (de skjules for andre end chef) - fristen står i Stripe.
    "Indsigelse: beviserne er lagt klar hos Stripe - gennemse og indsend dem i Stripe inden fristen (tilføj beskeder og billeder fra handlen)",
  );
}

// ------------------------------------------------------------------ tabt

// Henter beløbet tilbage fra sælgerens konto efter en tabt indsigelse før
// udbetaling. Returnerer "tilbagefoert", "allerede", "udbetalt" (BidHamr
// bærer tabet), "venter" (prøves igen) eller "stoppet" (til staff).
export async function tilbagefoerVedTabtIndsigelse(
  betalingId: string,
  dArg?: Stripe.Dispute,
): Promise<string> {
  const r = await tilbagefoerUdenBesked(betalingId, dArg);
  // "venter" = endnu uafklaret (fx en udbetaling er claimet/usikker): ingen
  // beskeder endnu - cron'en behandler betalingen igen, når udbetalingen er
  // afklaret (indsigelse_tabt_afklaret er tom).
  if (r === "venter") return r;
  const udfald = r === "udbetalt" ? "udbetalt" : r === "stoppet" ? "stoppet" : "tilbagefoert";
  const admin = createAdminClient();
  const { data: nyt, error: aFejl } = await admin.rpc("betaling_indsigelse_tabt_afklar", {
    p_betaling: betalingId,
    p_udfald: udfald,
  });
  if (aFejl && !manglerIDatabasen(aFejl)) console.error("betaling_indsigelse_tabt_afklar:", betalingId, aFejl.message);
  const { data: b } = await admin.from("betalinger").select(KOLONNER).eq("id", betalingId).maybeSingle<Raekke>();
  if (b?.pengemodel === "destination" && b.stripe_dispute_id) {
    if (nyt === true && udfald === "udbetalt") {
      await marker(
        admin,
        b.id,
        "Indsigelse tabt efter udbetaling: BidHamr bærer tabet - intet trækkes fra sælgeren. Køberen skal sende varen til BidHamr",
      );
    }
    // Først nu vides, om handlen var udbetalt. Én besked pr. indsigelse
    // (nøglerne), også hvis dette kaldes flere gange.
    await sendIndsigelseTilSaelger(b.stripe_dispute_id, b.stripe_payment_intent_id, b.stripe_charge_id, "tabt", {
      overfoert: udfald === "udbetalt",
    });
    await beskedTilKoeberVedTabt(admin, b, b.stripe_dispute_id, udfald === "udbetalt");
  }
  return r;
}

async function tilbagefoerUdenBesked(betalingId: string, dArg?: Stripe.Dispute): Promise<string> {
  const admin = createAdminClient();
  const stripe = getStripe();
  const { data: b, error } = await admin
    .from("betalinger")
    .select("id, trade_id, seller_id, stripe_dispute_id, stripe_charge_id, udbetaling_oere")
    .eq("id", betalingId)
    .maybeSingle<{ id: string; trade_id: string; seller_id: string; stripe_dispute_id: string | null; stripe_charge_id: string | null; udbetaling_oere: number }>();
  if (error) throw new Error(`tilbagefoerVedTabtIndsigelse: ${error.message}`);
  if (!b?.stripe_dispute_id || !b.stripe_charge_id) return "stoppet";

  const d = dArg ?? (await stripe.disputes.retrieve(b.stripe_dispute_id, {}, KALD));
  if (d.status !== "lost") return "venter";

  const { data: c, error: cFejl } = await admin.rpc("betaling_indsigelse_tilbagefoersel_claim", {
    p_betaling: b.id,
    p_omstridt: Number(d.amount),
  });
  if (cFejl) throw new Error(`betaling_indsigelse_tilbagefoersel_claim: ${cFejl.message}`);
  const claim = c as {
    kode: string;
    beloeb?: number;
    forsoeg?: number;
    transfer?: string;
    konto?: string;
    delvis?: boolean;
  };
  switch (claim.kode) {
    case "ok":
      break;
    case "allerede":
      return "allerede";
    case "udbetalt":
      // Markering og beskeder i tilbagefoerVedTabtIndsigelse (én gang).
      return "udbetalt";
    case "refusion":
      await stop(admin, b, "en refusion til køberen er allerede i gang eller gennemført - afgør pengene manuelt");
      return "stoppet";
    case "ugyldig":
      await stop(admin, b, "betalingen mangler overførslen til sælgeren");
      return "stoppet";
    default:
      // udbetaling_uafklaret, i_gang, venter, opgivet, ikke_tabt ...
      return claim.kode === "opgivet" ? "stoppet" : "venter";
  }

  const beloeb = Number(claim.beloeb);
  try {
    const charge = await stripe.charges.retrieve(b.stripe_charge_id, { expand: ["transfer", "application_fee"] }, KALD);
    const transfer = charge.transfer && typeof charge.transfer !== "string" ? charge.transfer : null;
    const fee = charge.application_fee && typeof charge.application_fee !== "string" ? charge.application_fee : null;
    if (!transfer || transfer.id !== claim.transfer || String(transfer.destination) !== claim.konto) {
      await stop(admin, b, "overførslen til sælgeren passer ikke med Stripe");
      return "stoppet";
    }
    if (Number(charge.amount_refunded) > 0 || Number(fee?.amount_refunded ?? 0) > 0) {
      await stop(admin, b, "der er refunderet på betalingen hos Stripe - afgør pengene manuelt");
      return "stoppet";
    }
    let reversal: Stripe.TransferReversal | null = null;
    const tilbagefoert = Number(transfer.amount_reversed);
    if (tilbagefoert === beloeb) {
      const liste = await stripe.transfers.listReversals(transfer.id, { limit: 10 }, KALD);
      reversal = liste.data.find((r) => r.metadata?.betaling_id === b.id) ?? null;
      if (!reversal) {
        await stop(admin, b, "overførslen er tilbageført hos Stripe af en anden end BidHamr");
        return "stoppet";
      }
    } else if (tilbagefoert !== 0) {
      await stop(admin, b, "overførslen er delvist tilbageført hos Stripe med et andet beløb");
      return "stoppet";
    } else {
      // Ingen negativ saldo på sælgerens konto pga. BidHamr.
      const saldo = await stripe.balance.retrieve({}, { ...KALD, stripeAccount: claim.konto });
      const iAlt = [...saldo.available, ...saldo.pending]
        .filter((x) => x.currency === "dkk")
        .reduce((s, x) => s + Number(x.amount), 0);
      if (iAlt < beloeb) {
        await logDriftFejl({
          kilde: "server",
          hvor: "betaling/saldo",
          fejl: `Tabt indsigelse: sælgerkonto ${claim.konto} har ikke nok på saldoen til tilbageførslen for handel ${b.trade_id} - intet er trukket. Kontrollér kontoen i Stripe.`,
          brugerId: b.seller_id,
        });
        await stop(admin, b, "sælgerens Stripe-konto har for lidt på saldoen");
        return "stoppet";
      }
      reversal = await stripe.transfers.createReversal(
        transfer.id,
        {
          amount: beloeb,
          refund_application_fee: false,
          metadata: { betaling_id: b.id, handel_id: b.trade_id, trin: "indsigelse_tabt", dispute: d.id },
        },
        { ...KALD, idempotencyKey: `bidhamr-indsigelse-tilbagefoersel-${b.id}-${claim.forsoeg ?? 0}` },
      );
      if (Number(reversal.amount) !== beloeb) {
        await stop(admin, b, "tilbageførslen hos Stripe har et andet beløb end forventet");
        return "stoppet";
      }
    }
    const { error: rFejl } = await admin.rpc("betaling_indsigelse_tilbagefoersel_registrer", {
      p_betaling: b.id,
      p_reversal: reversal.id,
    });
    if (rFejl) throw new Error(`betaling_indsigelse_tilbagefoersel_registrer: ${rFejl.message}`);
    if (claim.delvis) {
      await marker(
        admin,
        b.id,
        "Indsigelse tabt for en del af beløbet: kun det omstridte beløb er hentet tilbage fra sælgerens Stripe-konto - afgør resten",
      );
    }
    return "tilbagefoert";
  } catch (err) {
    if (err instanceof StripeTilstandFejl) {
      // Vagten stoppede kaldet (intet nåede Stripe): kun udsæt.
      await admin.rpc("betaling_indsigelse_tilbagefoersel_fejl", { p_betaling: b.id, p_besked: "Stripe-vagten", p_stop: false });
      throw err;
    }
    const kode = err instanceof Stripe.errors.StripeError ? (err.code ?? err.type) : "ukendt";
    const { data: f } = await admin.rpc("betaling_indsigelse_tilbagefoersel_fejl", {
      p_betaling: b.id,
      p_besked: `Stripe-fejl (${kode})`,
      p_stop: false,
    });
    if ((f as { opgivet?: boolean } | null)?.opgivet) {
      await logDriftFejl({
        kilde: "server",
        hvor: "betaling/indsigelse",
        fejl: `Tabt indsigelse: beløbet for handel ${b.trade_id} kunne ikke hentes tilbage fra sælgerens Stripe-konto efter 5 forsøg (${kode}) - se /admin/betalinger.`,
        brugerId: b.seller_id,
      });
    }
    throw err;
  }
}

async function stop(
  admin: Admin,
  b: { id: string; trade_id: string; seller_id: string },
  grund: string,
): Promise<void> {
  await admin.rpc("betaling_indsigelse_tilbagefoersel_fejl", { p_betaling: b.id, p_besked: grund, p_stop: true });
  await logDriftFejl({
    kilde: "server",
    hvor: "betaling/indsigelse",
    fejl: `Tabt indsigelse: tilbageførsel fra sælgerens konto stoppet for handel ${b.trade_id} - ${grund}.`,
    brugerId: b.seller_id,
  });
}

// Køberen får besked, når banken har givet ham pengene tilbage (destination).
// Er varen sendt/udleveret, skal den retur: til sælgeren før udbetaling, til
// BidHamr efter (Filip 8. okt. 2026). Én besked pr. indsigelse.
async function beskedTilKoeberVedTabt(admin: Admin, b: Raekke, disputeId: string, udbetalt: boolean): Promise<void> {
  try {
    const [{ data: h }, { data: a }] = await Promise.all([
      admin.from("trades").select("status, afhentning").eq("id", b.trade_id).maybeSingle(),
      admin.from("auctions").select("titel").eq("id", b.auction_id).maybeSingle(),
    ]);
    const vare = `"${(a?.titel as string | undefined) ?? "varen"}"`;
    const status = (h?.status as string | undefined) ?? "";
    const harVaren = ["pakke_sendt", "modtaget", "leveret", "afsluttet"].includes(status) || !!b.frigivet_kl;
    const tekst = !harVaren
      ? `Din bank har givet dig pengene tilbage for ${vare}. Handlen bliver annulleret.`
      : udbetalt
        ? `Din bank har givet dig pengene tilbage for ${vare}. Du skal derfor sende varen til BidHamr. Vi skriver til dig med adressen og hvordan du sender den.`
        : `Din bank har givet dig pengene tilbage for ${vare}. Du skal derfor sende varen tilbage til sælgeren. Vi skriver til dig om, hvordan du sender den.`;
    await send(b.buyer_id, "sag", {
      titel: harVaren ? "Send varen tilbage" : "Din bank har givet dig pengene tilbage",
      tekst,
      link: `/mine-handler/${b.trade_id}`,
      data: { trade_id: b.trade_id },
      noegle: `indsigelse_tabt_koeber:${disputeId}`,
    });
    if (harVaren) {
      await marker(
        admin,
        b.id,
        udbetalt
          ? "Indsigelse tabt: køberen skal sende varen til BidHamr - kontakt køberen med adresse"
          : "Indsigelse tabt: køberen skal sende varen tilbage til sælgeren - kontakt køber og sælger",
      );
    }
  } catch (err) {
    console.error("Besked til køber om tabt indsigelse fejlede:", disputeId, err);
  }
}

// ------------------------------------------------------------------ cron

// Tabte indsigelser før udbetaling, hvor beløbet endnu ikke er hentet tilbage
// fra sælgerens konto (fx fordi en udbetaling var uafklaret, eller Stripe
// fejlede). Spredte forsøg; efter 5 til staff.
export async function tilbagefoerTabteIndsigelserVentende(): Promise<number> {
  const admin = createAdminClient();
  const nu = new Date().toISOString();
  await udbetalingFejletEfterTabt(admin);
  // Alle tabte indsigelser, hvis udfald ikke er afklaret endnu - også dem med
  // en udbetaling (claimet/usikker -> vent; oprettet/betalt -> 'udbetalt').
  const { data, error } = await admin
    .from("betalinger")
    .select("id")
    .eq("pengemodel", "destination")
    .eq("indsigelse_status", "lost")
    .is("indsigelse_tabt_afklaret", null)
    .is("indsigelse_tilbagefoersel_id", null)
    .lt("indsigelse_tilbagefoersel_forsoeg", 5)
    .or(`indsigelse_tilbagefoersel_naeste_kl.is.null,indsigelse_tilbagefoersel_naeste_kl.lte.${nu}`)
    .limit(50);
  if (error) {
    if (manglerIDatabasen(error)) return 0;
    await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Tilbageførsel ved tabt indsigelse", fejl: error });
    return 0;
  }
  let antal = 0;
  for (const r of data ?? []) {
    try {
      if ((await tilbagefoerVedTabtIndsigelse(r.id as string)) === "tilbagefoert") antal++;
    } catch (err) {
      console.error("Tilbageførsel ved tabt indsigelse fejlede (prøves igen):", r.id, err);
      await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Tilbageførsel ved tabt indsigelse", fejl: err });
    }
  }
  return antal;
}

// Udfaldet var 'udbetalt' (BidHamr bærer tabet), men udbetalingen til
// sælgerens bank fejlede/blev annulleret bagefter (payout.failed efter paid):
// pengene står igen på sælgerens Stripe-konto. Chefens valg: intet flyttes
// automatisk (hverken tilbageførsel eller ny udbetaling) - markering og
// drift-alarm, staff afgør. Én gang pr. betaling. Kaster aldrig.
async function udbetalingFejletEfterTabt(admin: Admin): Promise<void> {
  try {
    const { data, error } = await admin
      .from("betalinger")
      .select("id, trade_id, seller_id")
      .eq("pengemodel", "destination")
      .eq("indsigelse_status", "lost")
      .eq("indsigelse_tabt_afklaret", "udbetalt")
      .is("saelger_udbetaling_id", null)
      .is("overfoersel_paabegyndt_kl", null)
      .limit(50);
    if (error) {
      if (!manglerIDatabasen(error)) throw new Error(error.message);
      return;
    }
    for (const r of data ?? []) {
      const { data: nyt } = await admin.rpc("betaling_indsigelse_tabt_afklar", {
        p_betaling: r.id,
        p_udfald: "udbetaling_fejlet",
      });
      if (nyt !== true) continue;
      await marker(
        admin,
        r.id as string,
        "Indsigelse tabt efter udbetaling, men udbetalingen til sælgerens bank fejlede bagefter: pengene står igen på sælgerens Stripe-konto og flyttes ikke automatisk - afgør manuelt",
      );
      await logDriftFejl({
        kilde: "cron",
        sti: "betalings-cron",
        hvor: "betaling/indsigelse",
        fejl: `Tabt indsigelse på handel ${r.trade_id}: udbetalingen til sælgerens bank fejlede efter afklaringen ('udbetalt'). Pengene står på sælgerens Stripe-konto - se /admin/betalinger.`,
        brugerId: r.seller_id as string,
      });
    }
  } catch (err) {
    console.error("udbetalingFejletEfterTabt fejlede:", err);
    await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Tilbageførsel ved tabt indsigelse", fejl: err });
  }
}

// Svarfristen for åbne indsigelser (destination): markering til staff og
// drift-alarm 48 og 12 timer før fristen (én gang hver). Beviser, der kun er
// lagt klar (submit: false), sendes IKKE til banken af sig selv - svarer
// BidHamr ikke inden fristen, er indsigelsen tabt (Stripes dokumentation).
export async function varslIndsigelsesfrister(): Promise<number> {
  const admin = createAdminClient();
  const graense = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
  const { data, error } = await admin
    .from("betalinger")
    .select("id, trade_id, seller_id, indsigelse_frist_kl, indsigelse_frist_varslet_48_kl, indsigelse_frist_varslet_12_kl")
    .eq("pengemodel", "destination")
    .in("indsigelse_status", ["needs_response", "warning_needs_response"])
    .not("indsigelse_frist_kl", "is", null)
    .lte("indsigelse_frist_kl", graense)
    .limit(100);
  if (error) {
    if (manglerIDatabasen(error)) return 0;
    await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Indsigelsesfrister", fejl: error });
    return 0;
  }
  let antal = 0;
  for (const r of data ?? []) {
    const tilbage = new Date(r.indsigelse_frist_kl as string).getTime() - Date.now();
    const timer = tilbage <= 12 * 60 * 60_000 ? 12 : 48;
    if (timer === 48 && r.indsigelse_frist_varslet_48_kl) continue;
    if (timer === 12 && r.indsigelse_frist_varslet_12_kl) continue;
    const { data: nyt } = await admin.rpc("betaling_indsigelse_frist_varsel", { p_betaling: r.id, p_timer: timer });
    if (nyt !== true) continue;
    antal++;
    const tekst =
      timer === 12
        ? "Indsigelse: fristen for at svare banken udløber inden for 12 timer - indsend beviserne i Stripe nu, ellers er indsigelsen tabt"
        : "Indsigelse: fristen for at svare banken udløber inden for 48 timer - gennemse og indsend beviserne i Stripe";
    await marker(admin, r.id as string, tekst);
    await logDriftFejl({
      kilde: "cron",
      sti: "betalings-cron",
      hvor: "betaling/indsigelse-frist",
      fejl: `${tekst} (handel ${r.trade_id}).`,
      brugerId: r.seller_id as string,
    });
  }
  return antal;
}

// Admin/chef: "Hent beløbet fra sælgeren igen" (rolle og inhabilitet tjekkes
// i databasen). Kaldes kun fra en admin-server-action.
export async function proevIndsigelseTilbagefoerselIgen(betalingId: string, medarbejderId: string): Promise<string> {
  const { data, error } = await createAdminClient().rpc("betaling_indsigelse_tilbagefoersel_proev_igen", {
    p_medarbejder: medarbejderId,
    p_betaling: betalingId,
  });
  if (error) throw new Error(`betaling_indsigelse_tilbagefoersel_proev_igen: ${error.message}`);
  const kode = String((data as { kode?: string } | null)?.kode ?? "ukendt");
  if (kode !== "ok") return kode;
  return tilbagefoerVedTabtIndsigelse(betalingId);
}
