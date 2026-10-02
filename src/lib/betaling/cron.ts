// Server-only: cron-kørslen for betalingsmodellen.
//
//   1. Luk udløbne auktioner (samme SQL-funktion som pg_cron kører hvert
//      minut). Den opretter handel + betaling med 24 timers frist.
//   2. Nye betalinger: forsøg autobetaling (tilvalg), send "du vandt"-mails.
//   3. Påmindelser 12 og 20 timer efter fristens start.
//   4. Overfør frigivne beløb, der ventede på sælgerens Connect-konto.
//   5. Refundér betalinger med afvigende beløb.
//   5b. Sagsrefusioner, der er claimet, men ikke gennemført hos Stripe.
//   5c. "Sag oprettet"-beskeder for sager, der ikke er notificeret (fx fra appen).
//   6. Fristen overskredet: annullér handlen (+ Stripe), opret sag til admin,
//      mail til køber og sælger.
//   7. Andenchance-tilbud: udløb efter 24 t, mails til sælger/byder.
//   8. Betalte handler, der ikke er afsluttet efter 14 dage: markeres til admin.
//   Trin 4 sender også påmindelser til sælgere uden udbetalingskonto
//   (straks, efter 3 og 7 dage) og markerer til admin efter 7 dage.
//
// Hver mail "claimes" atomisk i databasen FØR afsendelse, så samme mail aldrig
// sendes to gange, selv hvis to kørsler overlapper.

import { createAdminClient } from "@/lib/supabase/admin";
import { send } from "@/lib/notifikationer/send";
import { koerNotifikationsCron } from "@/lib/notifikationer/cron";
import { annullerUbetalte, behandlAndenchance } from "@/lib/betaling/ubetalt";
import { notificerNyeSager } from "@/lib/sagerServer";
import {
  betalingsPaamindelseMail,
  koeberAndenchanceAutobetaltMail,
  koeberAndenchanceBetalMail,
  koeberAutobetaltMail,
  koeberVandtMail,
  saelgerSolgtMail,
} from "@/lib/mails/handel";
import {
  type BetalingRaekke,
  forsoegAutobetaling,
  overfoerVentende,
  refunderAfvigelserVentende,
  refunderSagerVentende,
} from "@/lib/betaling/stripeBetaling";

const TIME = 60 * 60 * 1000;

// Sætter et tidsstempel-felt, hvis det er tomt. true = denne kørsel vandt.
async function claim(
  betalingId: string,
  felt: "vundet_mail_sendt_kl" | "paamindelse_24_sendt_kl" | "paamindelse_40_sendt_kl",
): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("betalinger")
    .update({ [felt]: new Date().toISOString() })
    .eq("id", betalingId)
    .is(felt, null)
    .select("id");
  return (data ?? []).length > 0;
}

async function opslag(betalinger: BetalingRaekke[]) {
  const admin = createAdminClient();
  const auktionIds = [...new Set(betalinger.map((b) => b.auction_id))];
  const brugerIds = [...new Set(betalinger.flatMap((b) => [b.buyer_id, b.seller_id]))];
  const [{ data: auktioner }, { data: brugere }] = await Promise.all([
    admin.from("auctions").select("id, titel").in("id", auktionIds),
    admin.from("users").select("id, email").in("id", brugerIds),
  ]);
  return {
    titel: new Map((auktioner ?? []).map((a) => [a.id as string, a.titel as string])),
    email: new Map((brugere ?? []).map((u) => [u.id as string, u.email as string])),
  };
}

export async function koerBetalingsCron() {
  const admin = createAdminClient();
  const resultat = {
    lukkede: 0,
    autobetalinger: 0,
    vundetMails: 0,
    paamindelser: 0,
    overfoersler: 0,
    afvigelsesrefusioner: 0,
    sagsrefusioner: 0,
    sagsbeskeder: 0,
    ubetalteAnnulleret: 0,
    ubetaltMails: 0,
    andenchanceUdloebne: 0,
    andenchanceMails: 0,
    ikkeAfsluttet: 0,
  };

  // 1) Luk auktioner og opret handel + betaling.
  const { data: lukkede, error: rpcFejl } = await admin.rpc("afslut_udloebne_auktioner");
  if (rpcFejl) console.error("afslut_udloebne_auktioner fejlede:", rpcFejl);
  resultat.lukkede = Number(lukkede ?? 0);

  // 2) Nye betalinger uden "du vandt"-mail.
  const { data: nye } = await admin
    .from("betalinger")
    .select("*")
    .is("vundet_mail_sendt_kl", null)
    .gte("oprettet", new Date(Date.now() - 7 * 24 * TIME).toISOString())
    .limit(200)
    .overrideTypes<BetalingRaekke[], { merge: false }>();

  for (const b of nye ?? []) {
    try {
      if (!b.autobetaling_forsoegt_kl && b.status === "afventer") {
        const r = await forsoegAutobetaling(b.id);
        if (r === "betalt" || r === "allerede_betalt") resultat.autobetalinger++;
      }
    } catch (err) {
      console.error("Autobetaling kastede:", b.id, err);
    }
  }

  if (nye && nye.length > 0) {
    const ids = nye.map((b) => b.id);
    const { data: friske } = await admin
      .from("betalinger")
      .select("*")
      .in("id", ids)
      .overrideTypes<BetalingRaekke[], { merge: false }>();
    const o = await opslag(friske ?? []);
    // Handler fra et accepteret andenchance-tilbud: køberen vandt ikke selv
    // auktionen, og sælgeren har fået "byderen sagde ja"-mailen.
    const { data: fraTilbud } = await admin
      .from("andenchance_tilbud")
      .select("ny_trade_id")
      .in("ny_trade_id", (friske ?? []).map((b) => b.trade_id));
    const andenchance = new Set((fraTilbud ?? []).map((t) => t.ny_trade_id as string));
    for (const b of friske ?? []) {
      if (!(await claim(b.id, "vundet_mail_sendt_kl"))) continue;
      const titel = o.titel.get(b.auction_id) ?? "din auktion";
      const erAndenchance = andenchance.has(b.trade_id);
      const koeberMail =
        b.status === "betalt"
          ? (erAndenchance ? koeberAndenchanceAutobetaltMail : koeberAutobetaltMail)(
              titel,
              Number(b.total_oere),
              b.trade_id,
            )
          : (erAndenchance ? koeberAndenchanceBetalMail : koeberVandtMail)(
              titel,
              Number(b.total_oere),
              b.trade_id,
              b.betal_senest,
            );
      const link = `/mine-handler/${b.trade_id}`;
      const k = await send(b.buyer_id, "vundet", {
        titel:
          b.status === "betalt"
            ? "Du vandt og har betalt"
            : erAndenchance
              ? "Betal for din vare"
              : "Du vandt auktionen",
        tekst:
          b.status === "betalt"
            ? `Du har købt "${titel}", og beløbet er trukket automatisk på dit gemte kort.`
            : `Du har købt "${titel}". Betal inden for 24 timer, ellers bliver handlen annulleret.`,
        link,
        data: { trade_id: b.trade_id, auction_id: b.auction_id },
        mail: koeberMail,
        noegle: `vundet:${b.id}`,
      });
      if (k.mail) resultat.vundetMails++;
      // Er der allerede betalt, har sælgeren fået "køberen har betalt"-beskeden.
      if (b.status !== "betalt" && !erAndenchance) {
        await send(b.seller_id, "vundet", {
          titel: "Din auktion er solgt",
          tekst: `"${titel}" er solgt. Vent med at sende varen, til køberen har betalt.`,
          link,
          data: { trade_id: b.trade_id, auction_id: b.auction_id },
          mail: saelgerSolgtMail(titel, Number(b.bud_oere), b.trade_id),
          noegle: `solgt:${b.id}`,
        });
      }
    }
  }

  // 3) Påmindelser. Fristen er 24 t: 12 t efter start = 12 t før frist,
  //    20 t efter start = 4 t før frist. Den sene tages først, så en kørsel
  //    efter nedetid ikke sender begge på én gang.
  //    Kolonnenavnene er historiske (fra 48-timers-fristen):
  //    paamindelse_24_sendt_kl dækker nu påmindelsen efter 12 t, og
  //    paamindelse_40_sendt_kl dækker nu påmindelsen efter 20 t.
  const nu = Date.now();
  for (const [felt, timerFoerFrist] of [
    ["paamindelse_40_sendt_kl", 4],
    ["paamindelse_24_sendt_kl", 12],
  ] as const) {
    const { data: mangler } = await admin
      .from("betalinger")
      .select("*")
      .eq("status", "afventer")
      .is(felt, null)
      .not("vundet_mail_sendt_kl", "is", null)
      .lte("betal_senest", new Date(nu + timerFoerFrist * TIME).toISOString())
      .gt("betal_senest", new Date(nu).toISOString())
      .limit(200)
      .overrideTypes<BetalingRaekke[], { merge: false }>();
    if (!mangler || mangler.length === 0) continue;
    const o = await opslag(mangler);
    for (const b of mangler) {
      if (!(await claim(b.id, felt))) continue;
      // Den sene påmindelse gør den tidlige overflødig, hvis cron har været nede.
      if (felt === "paamindelse_40_sendt_kl" && !b.paamindelse_24_sendt_kl) {
        await claim(b.id, "paamindelse_24_sendt_kl");
      }
      const titel = o.titel.get(b.auction_id) ?? "din auktion";
      const p = await send(b.buyer_id, "betalingsfrist", {
        titel: "Husk at betale",
        tekst: `Du har endnu ikke betalt for "${titel}". Fristen udløber om under ${timerFoerFrist} timer.`,
        link: `/mine-handler/${b.trade_id}`,
        data: { trade_id: b.trade_id },
        mail: betalingsPaamindelseMail(titel, Number(b.total_oere), b.trade_id, b.betal_senest),
        noegle: `paamindelse:${felt}:${b.id}`,
      });
      if (p.mail) resultat.paamindelser++;
    }
  }

  // 4) Frigivne beløb, der ventede på sælgerens konto (eller fejlede).
  resultat.overfoersler = await overfoerVentende();

  // 5) Betalinger med afvigende beløb, der endnu ikke er refunderet.
  resultat.afvigelsesrefusioner = await refunderAfvigelserVentende();

  // 5b) Sagsrefusioner (medhold til køber), hvor Stripe-kaldet fejlede.
  resultat.sagsrefusioner = await refunderSagerVentende();

  // 5c) Nye sager, hvor køber og sælger ikke har fået besked endnu.
  resultat.sagsbeskeder = await notificerNyeSager();

  // 6) Fristen overskredet: annullér handel + Stripe, opret sag, send mails.
  try {
    const r = await annullerUbetalte();
    resultat.ubetalteAnnulleret = r.annulleret;
    resultat.ubetaltMails = r.mails;
  } catch (err) {
    console.error("Annullering af ubetalte handler fejlede:", err);
  }

  // 8) Betalte handler, der ikke er afsluttet efter 14 dage: til admin.
  const { data: haengende, error: haengFejl } = await admin.rpc(
    "betaling_marker_ikke_afsluttet",
  );
  if (haengFejl) console.error("betaling_marker_ikke_afsluttet fejlede:", haengFejl);
  resultat.ikkeAfsluttet = Number(haengende ?? 0);

  // 7) Andenchance-tilbud: udløb og mails.
  try {
    const r = await behandlAndenchance();
    resultat.andenchanceUdloebne = r.udloebne;
    resultat.andenchanceMails = r.mails;
  } catch (err) {
    console.error("Andenchance-trinnet fejlede:", err);
  }

  // 9) Notifikationer om likes, beskeder, favoritter der slutter snart, nye
  //    auktioner fra fulgte sælgere og advarsler. Kaster aldrig.
  const notifikationer = await koerNotifikationsCron();

  return { ...resultat, notifikationer };
}
