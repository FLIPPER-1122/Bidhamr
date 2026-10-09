// Server-only: cron-kørslen for betalingsmodellen.
//
//   1. Luk udløbne auktioner (samme SQL-funktion som pg_cron kører hvert
//      minut). Den opretter handel + betaling med 48 timers frist.
//   2. Nye betalinger: forsøg autobetaling (tilvalg), send "du vandt"-mails.
//   3. Påmindelser 24 og 8 timer før fristen.
//   3b. Sager, hvor ankefristen (4 dage efter afgørelsen) er udløbet: refusion
//       til køber / frigivelse til sælger / frysningen fjernes.
//   3c. Automatisk frigivelse: 48 t efter "modtaget" uden sag, eller 14 dage
//       efter afsendelse uden "modtaget" og uden sag. Køberen får en
//       påmindelse på dag 12.
//   4. Udbetal frigivne beløb fra sælgerens Connect-konto til banken
//      (udbetalVentende - F03, saldo-afstemning, udbetal_tidligst).
//   5. Refundér betalinger med afvigende beløb.
//   5b. Alle lovede refusioner (uanset årsag), der er claimet, men ikke
//       gennemført hos Stripe - med backoff (Niels F05).
//   5b2. Destination: tabte indsigelser før udbetaling - beløbet hentes
//       tilbage fra sælgerens Stripe-konto (spredte forsøg, højst 5).
//   5b3. Destination: varsel til staff 48 og 12 timer før indsigelsens svarfrist.
//   5c. "Sag oprettet"-beskeder for sager, der ikke er notificeret (fx fra appen).
//   6. Fristen overskredet: annullér handlen (+ Stripe), opret sag til admin,
//      mail til køber og sælger.
//   6b. Afsendelsesfrist: påmindelse til sælgeren efter dag 3 og 4; ikke
//       sendt 5 dage efter betalingen -> handlen annulleres, og køberen
//       refunderes fuldt via Stripe (kun forsendelse, ikke afhentning).
//   7. Andenchance-tilbud: udløb efter 24 t, mails til sælger/byder.
//   8. Betalte handler, der ikke er afsluttet efter 14 dage: markeres til admin.
//   8b. Afhentningshandler, der ikke er hentet inden afhentningsfristen
//       (7 dage efter betalingen, evt. forlænget af sælgeren): markeres til
//       staff. Ingen automatisk frigivelse ved afhentning.
//   8c. Afhentningsfrist: påmindelse til køber og sælger 2 døgn før fristen
//       (dag 5). Er varen ikke hentet, og har staff ikke afgjort handlen 14
//       dage efter betalingen (og mindst 7 dage efter fristen), annulleres
//       handlen, og køberen får alle pengene tilbage via Stripe.
//   10. Overvågning (Niels F06, overvaagning.ts - højst én gang i timen):
//       udbetalinger, der hænger, tabte indsigelser uden afklaring,
//       saldo-afstemning og udeblevne payout-/indsigelses-events. Én
//       drift-alarm pr. tilfælde.
//
// Hver mail "claimes" atomisk i databasen FØR afsendelse, så samme mail aldrig
// sendes to gange, selv hvis to kørsler overlapper.

import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { send } from "@/lib/notifikationer/send";
import { koerNotifikationsCron } from "@/lib/notifikationer/cron";
import { annullerUbetalte, behandlAndenchance } from "@/lib/betaling/ubetalt";
import {
  afviklForfaldneSager,
  notificerNyeAnker,
  notificerNyeSager,
  notificerReturKanSendes,
} from "@/lib/sagerServer";
import { frigivAutomatisk, paamindKoeberOmModtagelse } from "@/lib/betaling/autoFrigiv";
import { annullerIkkeSendte, paamindSaelgerOmAfsendelse } from "@/lib/betaling/afsendelsesfrist";
import { annullerIkkeHentede, paamindOmAfhentning } from "@/lib/betaling/afhentningsfrist";
import {
  betalingsPaamindelseMail,
  koeberAndenchanceAutobetaltMail,
  koeberAndenchanceBetalMail,
  koeberAutobetaltMail,
  koeberVandtMail,
  koeberVandtVenterMail,
  saelgerKontoIkkeKlarMail,
  saelgerSolgtMail,
} from "@/lib/mails/handel";
import { behandlVentendeBetalinger } from "@/lib/betaling/betalingInd";
import { udbetalVentende } from "@/lib/betaling/udbetaling";
import { tilbagefoerTabteIndsigelserVentende, varslIndsigelsesfrister } from "@/lib/betaling/indsigelse";
import {
  type BetalingRaekke,
  forsoegAutobetaling,
  refunderAfvigelserVentende,
  refunderLoveteVentende,
} from "@/lib/betaling/stripeBetaling";
import { koerBetalingsovervaagning } from "@/lib/betaling/overvaagning";
import { databasenErDestination } from "@/lib/betaling/model";
import { alarmPrTilfaelde, lukTilfaelde } from "@/lib/betaling/driftTilfaelde";

const TIME = 60 * 60 * 1000;

// Et trin fejlede: log til konsollen og til drift_fejl (/admin/drift).
// Kørslen fortsætter med de næste trin. Kaster aldrig.
async function trinFejl(trin: string, err: unknown, ...detaljer: unknown[]) {
  console.error(`${trin} fejlede:`, ...detaljer, err);
  await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: trin, fejl: err });
}

// Sætter et tidsstempel-felt, hvis det er tomt. true = denne kørsel vandt.
// Med betalSenest lykkes claimet kun, hvis fristen stadig er den, kørslen
// læste - så en påmindelse aldrig sendes med en frist, sælgeren lige har
// forlænget (forlængelsen nulstiller felterne; næste kørsel tager den nye).
async function claim(
  betalingId: string,
  felt: "vundet_mail_sendt_kl" | "paamindelse_24_sendt_kl" | "paamindelse_40_sendt_kl",
  betalSenest?: string,
): Promise<boolean> {
  let q = createAdminClient()
    .from("betalinger")
    .update({ [felt]: new Date().toISOString() })
    .eq("id", betalingId)
    .is(felt, null);
  if (betalSenest !== undefined) q = q.eq("betal_senest", betalSenest);
  const { data } = await q.select("id");
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
    udbetalinger: 0,
    afvigelsesrefusioner: 0,
    sagsrefusioner: 0,
    indsigelseTilbagefoersler: 0,
    indsigelseFristVarsler: 0,
    sagsbeskeder: 0,
    ankebeskeder: 0,
    returbeskeder: 0,
    sagsafviklinger: 0,
    autoFrigivet: 0,
    paamindelserModtaget: 0,
    ubetalteAnnulleret: 0,
    ubetaltMails: 0,
    afsendelsesPaamindelser: 0,
    ikkeSendtAnnulleret: 0,
    ikkeSendtRefunderet: 0,
    andenchanceUdloebne: 0,
    andenchanceMails: 0,
    ikkeAfsluttet: 0,
    ikkeAfhentet: 0,
    afhentningsPaamindelser: 0,
    ikkeHentetAnnulleret: 0,
    ikkeHentetRefunderet: 0,
    overvaagning: {} as Awaited<ReturnType<typeof koerBetalingsovervaagning>>,
    ventende: {} as Awaited<ReturnType<typeof behandlVentendeBetalinger>>,
  };

  // 0) Databasen er ikke migreret til betalingsmodellen destination (trin
  //    1-5): ingen pengetrin (de ville fejle eller bruge den gamle model).
  //    Kun notifikationer kører. Én drift-alarm, til det er løst - ikke
  //    en fejlet kørsel hvert 5. minut. Se docs/GO-LIVE-STRIPE.md.
  if (!(await databasenErDestination())) {
    await alarmPrTilfaelde({
      noegle: "cron:betalingsmodel",
      hvor: "betaling/betalingsmodel",
      fejl: "Betalings-cron springer alle pengetrin over: databasens betalingsmodel er ikke 'destination' (migrationerne for trin 1-5 er ikke kørt). Kør prod-koersel-filen - se docs/GO-LIVE-STRIPE.md.",
    });
    const notifikationer = await koerNotifikationsCron();
    return { ...resultat, springetOver: 1, notifikationer };
  }
  await lukTilfaelde("cron:betalingsmodel");

  // 1) Luk auktioner og opret handel + betaling.
  const { data: lukkede, error: rpcFejl } = await admin.rpc("afslut_udloebne_auktioner");
  if (rpcFejl) await trinFejl("afslut_udloebne_auktioner", rpcFejl);
  resultat.lukkede = Number(lukkede ?? 0);

  // 1b) Betalinger, der venter på sælgerens Stripe-konto, åbnes, påmindes
  //     eller annulleres (betalingInd.ts).
  resultat.ventende = await behandlVentendeBetalinger();

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
      await trinFejl("Autobetaling", err, b.id);
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
      const link = `/mine-handler/${b.trade_id}`;
      // Betalingen venter på sælgerens Stripe-konto (destination): køberen
      // kan ikke betale endnu, og sælgeren skal gøre kontoen færdig.
      if (b.venter_paa_saelgerkonto_kl && b.status === "afventer") {
        const k = await send(b.buyer_id, "vundet", {
          titel: erAndenchance ? "Din vare venter på sælgeren" : "Du vandt auktionen",
          tekst: `Du har købt "${titel}". Du kan betale, så snart sælgerens konto er godkendt hos vores betalingspartner Stripe – vi giver dig besked.`,
          link,
          data: { trade_id: b.trade_id, auction_id: b.auction_id },
          mail: koeberVandtVenterMail(titel, Number(b.total_oere), b.trade_id),
          noegle: `vundet:${b.id}`,
        });
        if (k.mail) resultat.vundetMails++;
        await send(b.seller_id, "vundet", {
          titel: "Din auktion er solgt – gør din konto færdig",
          tekst: `"${titel}" er solgt, men køberen kan først betale, når din konto hos Stripe er godkendt. Gør opsætningen færdig under Min konto.`,
          link: "/konto",
          data: { trade_id: b.trade_id, auction_id: b.auction_id },
          mail: saelgerKontoIkkeKlarMail(titel, false),
          noegle: `solgt:${b.id}`,
        });
        continue;
      }
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
            : `Du har købt "${titel}". Betal inden for 48 timer, ellers bliver handlen annulleret.`,
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

  // 3) Påmindelser. Fristen er 48 t: 24 t efter start = 24 t før frist,
  //    40 t efter start = 8 t før frist. Den sene tages først, så en kørsel
  //    efter nedetid ikke sender begge på én gang.
  //    Påmindelserne regnes fra fristen, så de også passer, når sælgeren har
  //    forlænget den (handel_forlaeng_betalingsfrist nulstiller begge felter,
  //    og nøglen indeholder fristen, så køberen påmindes igen).
  const nu = Date.now();
  for (const [felt, timerFoerFrist] of [
    ["paamindelse_40_sendt_kl", 8],
    ["paamindelse_24_sendt_kl", 24],
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
      // Venter på sælgerens konto: betal_senest er fristen for kontoen, ikke
      // købers betalingsfrist - ingen påmindelse.
      if (b.venter_paa_saelgerkonto_kl) continue;
      if (!(await claim(b.id, felt, b.betal_senest))) continue;
      // Den sene påmindelse gør den tidlige overflødig, hvis cron har været nede.
      if (felt === "paamindelse_40_sendt_kl" && !b.paamindelse_24_sendt_kl) {
        await claim(b.id, "paamindelse_24_sendt_kl", b.betal_senest);
      }
      const titel = o.titel.get(b.auction_id) ?? "din auktion";
      const p = await send(b.buyer_id, "betalingsfrist", {
        titel: "Husk at betale",
        tekst: `Du har endnu ikke betalt for "${titel}". Fristen udløber om under ${timerFoerFrist} timer.`,
        link: `/mine-handler/${b.trade_id}`,
        data: { trade_id: b.trade_id },
        mail: betalingsPaamindelseMail(titel, Number(b.total_oere), b.trade_id, b.betal_senest),
        noegle: `paamindelse:${felt}:${b.id}:${new Date(b.betal_senest).getTime()}`,
      });
      if (p.mail) resultat.paamindelser++;
    }
  }

  // 3b) Ankefristen er udløbet: flyt pengene efter sagens afgørelse. Kører
  //     før den automatiske frigivelse, så en lukket sag (frysningen fjernes)
  //     kan frigives i samme kørsel.
  try {
    resultat.sagsafviklinger = await afviklForfaldneSager();
  } catch (err) {
    await trinFejl("Afvikling af sager efter ankefristen", err);
  }

  // 3c) Automatisk frigivelse (48 t efter "modtaget" / 14 dage efter afsendelse).
  //     Først påmindelsen til køberen på dag 12 (kaster aldrig).
  resultat.paamindelserModtaget = await paamindKoeberOmModtagelse();
  try {
    resultat.autoFrigivet = await frigivAutomatisk();
  } catch (err) {
    await trinFejl("Automatisk frigivelse", err);
  }

  // 4) Udbetaling fra sælgerens Stripe-konto til banken for handler, der er
  //    helt færdige (samlet pr. sælger).
  resultat.udbetalinger = await udbetalVentende();

  // 5) Betalinger med afvigende beløb, der endnu ikke er refunderet.
  resultat.afvigelsesrefusioner = await refunderAfvigelserVentende();

  // 5b) ALLE lovede refusioner (sag, admin, sen betaling, frister), hvor
  //     Stripe-kaldet fejlede eller aldrig blev lavet - med backoff.
  resultat.sagsrefusioner = await refunderLoveteVentende();
  // 5b2) Destination (trin 4): tabte indsigelser før udbetaling - beløbet
  //      hentes tilbage fra sælgerens Stripe-konto (spredte forsøg, højst 5).
  resultat.indsigelseTilbagefoersler = await tilbagefoerTabteIndsigelserVentende();
  // 5b3) Destination: svarfristen for åbne indsigelser - varsel 48 og 12 t før.
  resultat.indsigelseFristVarsler = await varslIndsigelsesfrister();

  // 5c) Nye sager, hvor køber og sælger ikke har fået besked endnu.
  resultat.sagsbeskeder = await notificerNyeSager();
  // 5d) Nye anker (fx indgivet fra appen), hvor parterne ikke har fået besked.
  resultat.ankebeskeder = await notificerNyeAnker();
  // 5e) Ankefristen er udløbet på et medhold med retur: køberen kan sende varen.
  try {
    resultat.returbeskeder = await notificerReturKanSendes();
  } catch (err) {
    await trinFejl("Beskeder om retur efter ankefristen", err);
  }

  // 6) Fristen overskredet: annullér handel + Stripe, opret sag, send mails.
  try {
    const r = await annullerUbetalte();
    resultat.ubetalteAnnulleret = r.annulleret;
    resultat.ubetaltMails = r.mails;
  } catch (err) {
    await trinFejl("Annullering af ubetalte handler", err);
  }

  // 6b) Afsendelsesfrist: først påmindelserne (dag 3 og 4), så annullering
  //     + fuld refusion af handler, der ikke er sendt 5 dage efter
  //     betalingen. Kaster aldrig.
  resultat.afsendelsesPaamindelser = await paamindSaelgerOmAfsendelse();
  {
    const r = await annullerIkkeSendte();
    resultat.ikkeSendtAnnulleret = r.annulleret;
    resultat.ikkeSendtRefunderet = r.refunderet;
  }

  // 8) Betalte handler, der ikke er afsluttet efter 14 dage: til admin.
  const { data: haengende, error: haengFejl } = await admin.rpc(
    "betaling_marker_ikke_afsluttet",
  );
  if (haengFejl) await trinFejl("betaling_marker_ikke_afsluttet", haengFejl);
  resultat.ikkeAfsluttet = Number(haengende ?? 0);

  // 8b) Afhentning ikke gennemført inden fristen: til staff.
  const { data: ikkeHentet, error: hentFejl } = await admin.rpc(
    "afhentning_marker_ikke_hentet",
  );
  if (hentFejl) await trinFejl("afhentning_marker_ikke_hentet", hentFejl);
  resultat.ikkeAfhentet = Number(ikkeHentet ?? 0);

  // 8c) Afhentningsfrist: påmindelser (dag 5), så automatisk tilbagebetaling
  //     af handler, der ikke er hentet, og som staff ikke har afgjort.
  //     Kaster aldrig.
  resultat.afhentningsPaamindelser = await paamindOmAfhentning();
  {
    const r = await annullerIkkeHentede();
    resultat.ikkeHentetAnnulleret = r.annulleret;
    resultat.ikkeHentetRefunderet = r.refunderet;
  }

  // 7) Andenchance-tilbud: udløb og mails.
  try {
    const r = await behandlAndenchance();
    resultat.andenchanceUdloebne = r.udloebne;
    resultat.andenchanceMails = r.mails;
  } catch (err) {
    await trinFejl("Andenchance-trinnet", err);
  }

  // 10) Overvågning (F06). Kaster aldrig; et fejlet tjek logges med kilde
  //     'cron' (kørslen markeres som fejlet).
  resultat.overvaagning = await koerBetalingsovervaagning();

  // 9) Notifikationer om likes, beskeder, favoritter der slutter snart, nye
  //    auktioner fra fulgte sælgere og advarsler. Kaster aldrig.
  const notifikationer = await koerNotifikationsCron();

  return { ...resultat, notifikationer };
}
