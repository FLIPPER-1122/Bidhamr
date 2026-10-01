// Server-only: cron-kørslen for betalingsmodellen.
//
//   1. Luk udløbne auktioner (samme SQL-funktion som pg_cron kører hvert
//      minut). Den opretter handel + betaling med 48 timers frist.
//   2. Nye betalinger: forsøg autobetaling (tilvalg), send "du vandt"-mails.
//   3. Påmindelser 24 og 40 timer efter fristens start.
//   4. Overfør frigivne beløb, der ventede på sælgerens Connect-konto.
//
// Hver mail "claimes" atomisk i databasen FØR afsendelse, så samme mail aldrig
// sendes to gange, selv hvis to kørsler overlapper.

import { createAdminClient } from "@/lib/supabase/admin";
import { getResend } from "@/lib/resend";
import {
  HANDEL_AFSENDER,
  betalingsPaamindelseMail,
  koeberAutobetaltMail,
  koeberVandtMail,
  saelgerSolgtMail,
} from "@/lib/mails/handel";
import {
  type BetalingRaekke,
  forsoegAutobetaling,
  overfoerVentende,
  refunderAfvigelserVentende,
} from "@/lib/betaling/stripeBetaling";

const TIME = 60 * 60 * 1000;

type Mail = { subject: string; html: string };

async function sendMail(til: string | undefined, mail: Mail): Promise<boolean> {
  if (!til) return false;
  const resend = getResend();
  if (!resend) {
    console.warn("RESEND_API_KEY mangler - mail ikke sendt:", mail.subject);
    return false;
  }
  try {
    const { error } = await resend.emails.send({
      from: HANDEL_AFSENDER,
      to: til,
      subject: mail.subject,
      html: mail.html,
    });
    if (error) {
      console.error("Mail fejlede:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Mail kastede:", err);
    return false;
  }
}

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
    for (const b of friske ?? []) {
      if (!(await claim(b.id, "vundet_mail_sendt_kl"))) continue;
      const titel = o.titel.get(b.auction_id) ?? "din auktion";
      const koeberMail =
        b.status === "betalt"
          ? koeberAutobetaltMail(titel, Number(b.total_oere), b.trade_id)
          : koeberVandtMail(titel, Number(b.total_oere), b.trade_id, b.betal_senest);
      if (await sendMail(o.email.get(b.buyer_id), koeberMail)) resultat.vundetMails++;
      // Er der allerede betalt, har sælgeren fået "køberen har betalt"-mailen.
      if (b.status !== "betalt") {
        await sendMail(
          o.email.get(b.seller_id),
          saelgerSolgtMail(titel, Number(b.bud_oere), b.trade_id),
        );
      }
    }
  }

  // 3) Påmindelser. Fristen er 48 t: 24 t efter start = 24 t før frist,
  //    40 t efter start = 8 t før frist. Den sene tages først, så en kørsel
  //    efter nedetid ikke sender begge på én gang.
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
      if (!(await claim(b.id, felt))) continue;
      // Den sene påmindelse gør den tidlige overflødig, hvis cron har været nede.
      if (felt === "paamindelse_40_sendt_kl" && !b.paamindelse_24_sendt_kl) {
        await claim(b.id, "paamindelse_24_sendt_kl");
      }
      const mail = betalingsPaamindelseMail(
        o.titel.get(b.auction_id) ?? "din auktion",
        Number(b.total_oere),
        b.trade_id,
        b.betal_senest,
      );
      if (await sendMail(o.email.get(b.buyer_id), mail)) resultat.paamindelser++;
    }
  }

  // 4) Frigivne beløb, der ventede på sælgerens konto (eller fejlede).
  resultat.overfoersler = await overfoerVentende();

  // 5) Betalinger med afvigende beløb, der endnu ikke er refunderet.
  resultat.afvigelsesrefusioner = await refunderAfvigelserVentende();

  return resultat;
}
