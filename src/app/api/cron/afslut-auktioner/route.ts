import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getResend } from "@/lib/resend";
import {
  HANDEL_AFSENDER,
  koeberVandtMail,
  saelgerSolgtMail,
} from "@/lib/mails/handel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Kun auktioner der er lukket inden for denne periode får oprettet en handel.
// Uden grænsen ville en førstegangskørsel backfille hele historikken.
const BACKFILL_DAGE = 7;

type AuktionRaekke = {
  id: string;
  titel: string;
  bruger_id: string;
  vinder_id: string | null;
  nuværende_bud: number | string | null;
};

function harAdgang(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  // Fail closed: uden en konfigureret hemmelighed afvises alt.
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function afslutAuktioner() {
  const admin = createAdminClient();

  // 1) Defensiv lukning gennem præcis samme funktion som pg_cron kalder, så
  //    logikken ikke kan divergere. Idempotent update - den der kommer sidst
  //    rammer 0 rækker, så der er intet kapløb.
  const { data: lukkede, error: rpcFejl } = await admin.rpc(
    "afslut_udloebne_auktioner",
  );
  if (rpcFejl) {
    console.error("Kunne ikke lukke udløbne auktioner:", rpcFejl);
  }

  // 2) Find afsluttede auktioner med en vinder.
  const graense = new Date(
    Date.now() - BACKFILL_DAGE * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: auktioner, error: auktionFejl } = await admin
    .from("auctions")
    .select("id, titel, bruger_id, vinder_id, nuværende_bud")
    .eq("status", "afsluttet")
    .not("vinder_id", "is", null)
    .gte("slutter_kl", graense)
    .order("slutter_kl", { ascending: false })
    .limit(200)
    .overrideTypes<AuktionRaekke[], { merge: false }>();

  if (auktionFejl) throw new Error(auktionFejl.message);
  if (!auktioner || auktioner.length === 0) {
    return { lukkede: lukkede ?? 0, oprettede: 0 };
  }

  // Ét opslag frem for ét pr. auktion.
  const { data: eksisterende } = await admin
    .from("trades")
    .select("auction_id")
    .in(
      "auction_id",
      auktioner.map((a) => a.id),
    );
  const harHandel = new Set((eksisterende ?? []).map((t) => t.auction_id));

  const nye = auktioner
    .filter((a) => !harHandel.has(a.id) && a.vinder_id)
    .map((a) => ({
      auction_id: a.id,
      seller_id: a.bruger_id,
      buyer_id: a.vinder_id as string,
      amount: Number(a["nuværende_bud"] ?? 0),
    }));

  if (nye.length === 0) {
    return { lukkede: lukkede ?? 0, oprettede: 0 };
  }

  // 3) De rækker upsert'en faktisk oprettede er idempotens-nøglen: en
  //    no-op returnerer intet, og så sendes der ingen mails igen.
  const { data: oprettede, error: insertFejl } = await admin
    .from("trades")
    .upsert(nye, { onConflict: "auction_id", ignoreDuplicates: true })
    .select("id, auction_id, buyer_id, seller_id, amount");

  if (insertFejl) throw new Error(insertFejl.message);
  const handler = oprettede ?? [];
  if (handler.length === 0) {
    return { lukkede: lukkede ?? 0, oprettede: 0 };
  }

  // 4) Mails. Fejler afsendelsen, må det ikke vælte kørslen - handlerne er
  //    oprettet, og de er synlige i appen uanset hvad.
  let sendteMails = 0;
  const resend = getResend();
  if (!resend) {
    console.warn("RESEND_API_KEY mangler - handelsmails blev ikke sendt.");
  } else {
    const titelMap = new Map(auktioner.map((a) => [a.id, a.titel]));
    const brugerIds = [
      ...new Set(handler.flatMap((h) => [h.buyer_id, h.seller_id])),
    ];
    const { data: brugere } = await admin
      .from("users")
      .select("id, email")
      .in("id", brugerIds);
    const emailMap = new Map((brugere ?? []).map((u) => [u.id, u.email]));

    for (const handel of handler) {
      const titel = titelMap.get(handel.auction_id) ?? "din auktion";
      const beloeb = Number(handel.amount);

      for (const [modtagerId, mail] of [
        [handel.buyer_id, koeberVandtMail(titel, beloeb, handel.id)] as const,
        [handel.seller_id, saelgerSolgtMail(titel, beloeb, handel.id)] as const,
      ]) {
        const til = emailMap.get(modtagerId);
        if (!til) continue;
        try {
          const { error } = await resend.emails.send({
            from: HANDEL_AFSENDER,
            to: til,
            subject: mail.subject,
            html: mail.html,
          });
          if (error) console.error("Handelsmail fejlede:", error);
          else sendteMails++;
        } catch (err) {
          console.error("Handelsmail kastede:", err);
        }
      }
    }
  }

  return { lukkede: lukkede ?? 0, oprettede: handler.length, mails: sendteMails };
}

async function haandter(req: NextRequest) {
  if (!harAdgang(req)) {
    return NextResponse.json({ fejl: "Ingen adgang" }, { status: 401 });
  }

  try {
    return NextResponse.json(await afslutAuktioner());
  } catch (err) {
    console.error("Cron-kørsel fejlede:", err);
    return NextResponse.json(
      { fejl: err instanceof Error ? err.message : "Ukendt fejl" },
      { status: 500 },
    );
  }
}

// GET til Vercel Cron (sender selv Authorization-headeren), POST til manuel kørsel.
export const GET = haandter;
export const POST = haandter;
