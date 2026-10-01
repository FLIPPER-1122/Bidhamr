import "server-only";

// Vinderen betaler ikke (ROADMAP-BESLUTNINGER.md, 2. oktober 2026).
// Deles af cron og server actions. Hver mail claimes atomisk (tidsstempel sat
// fra NULL) FØR afsendelse, så den aldrig sendes to gange.

import { createAdminClient } from "@/lib/supabase/admin";
import { annullerBetaling } from "@/lib/betaling/stripeBetaling";
import { sendHandelMail } from "@/lib/mails/send";
import {
  andenchanceTilbudMail,
  koeberUbetaltAnnulleretMail,
  saelgerAndenchanceAccepteretMail,
  saelgerAndenchanceAfslaaetMail,
  saelgerUbetaltAnnulleretMail,
} from "@/lib/mails/handel";

type Admin = ReturnType<typeof createAdminClient>;

async function claimFelt(
  admin: Admin,
  tabel: "ubetalte_vindere" | "andenchance_tilbud",
  id: string,
  felt: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from(tabel)
    .update({ [felt]: new Date().toISOString() })
    .eq("id", id)
    .is(felt, null)
    .select("id");
  if (error) {
    console.error(`claim ${tabel}.${felt} fejlede:`, error);
    return false;
  }
  return (data ?? []).length > 0;
}

async function titelOgEmails(admin: Admin, auktionId: string, brugerIds: string[]) {
  const [{ data: auktion }, { data: brugere }] = await Promise.all([
    admin.from("auctions").select("titel").eq("id", auktionId).maybeSingle(),
    admin.from("users").select("id, email").in("id", brugerIds),
  ]);
  return {
    titel: (auktion?.titel as string | undefined) ?? "din auktion",
    email: new Map((brugere ?? []).map((u) => [u.id as string, u.email as string])),
  };
}

// --- Annullering af ubetalte handler ------------------------------------------

type SagRaekke = {
  id: string;
  trade_id: string;
  auction_id: string;
  buyer_id: string;
  seller_id: string;
  stripe_annulleret_kl: string | null;
  koeber_mail_sendt_kl: string | null;
  saelger_mail_sendt_kl: string | null;
};

// Cron-trin: annullerer betalinger med overskreden frist, opretter sagen,
// annullerer PaymentIntent hos Stripe og sender mails. Alt er idempotent og
// genoptages i næste kørsel, hvis noget fejler undervejs.
export async function annullerUbetalte(): Promise<{ annulleret: number; mails: number }> {
  const admin = createAdminClient();
  let annulleret = 0;
  let mails = 0;

  const { data: forfaldne, error } = await admin
    .from("betalinger")
    .select("trade_id")
    .in("status", ["afventer", "behandles"])
    .lt("betal_senest", new Date().toISOString())
    .limit(200);
  if (error) console.error("Kunne ikke hente forfaldne betalinger:", error);

  for (const { trade_id } of forfaldne ?? []) {
    const { data, error: rpcFejl } = await admin.rpc("ubetalt_vinder_annuller", {
      p_trade: trade_id,
    });
    if (rpcFejl) {
      console.error("ubetalt_vinder_annuller fejlede:", trade_id, rpcFejl);
      continue;
    }
    if ((data as { annulleret?: boolean } | null)?.annulleret) annulleret++;
  }

  // Sager, hvor Stripe-annullering eller mails mangler (også fra tidligere
  // kørsler, der blev afbrudt).
  const { data: sager } = await admin
    .from("ubetalte_vindere")
    .select(
      "id, trade_id, auction_id, buyer_id, seller_id, stripe_annulleret_kl, koeber_mail_sendt_kl, saelger_mail_sendt_kl",
    )
    .or("stripe_annulleret_kl.is.null,koeber_mail_sendt_kl.is.null,saelger_mail_sendt_kl.is.null")
    .gte("oprettet", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .limit(200)
    .overrideTypes<SagRaekke[], { merge: false }>();

  for (const s of sager ?? []) {
    if (!s.stripe_annulleret_kl) {
      try {
        // Idempotent: betaling_annuller returnerer PaymentIntent-id'et igen for
        // en allerede annulleret betaling, og Stripe-kaldet har idempotensnøgle.
        await annullerBetaling(s.trade_id);
        await admin
          .from("ubetalte_vindere")
          .update({ stripe_annulleret_kl: new Date().toISOString() })
          .eq("id", s.id)
          .is("stripe_annulleret_kl", null);
      } catch (err) {
        console.error("Stripe-annullering fejlede:", s.trade_id, err);
      }
    }

    if (s.koeber_mail_sendt_kl && s.saelger_mail_sendt_kl) continue;
    const o = await titelOgEmails(admin, s.auction_id, [s.buyer_id, s.seller_id]);
    if (!s.koeber_mail_sendt_kl && (await claimFelt(admin, "ubetalte_vindere", s.id, "koeber_mail_sendt_kl"))) {
      if (await sendHandelMail(o.email.get(s.buyer_id), koeberUbetaltAnnulleretMail(o.titel, s.trade_id))) mails++;
    }
    if (!s.saelger_mail_sendt_kl && (await claimFelt(admin, "ubetalte_vindere", s.id, "saelger_mail_sendt_kl"))) {
      if (await sendHandelMail(o.email.get(s.seller_id), saelgerUbetaltAnnulleretMail(o.titel, s.trade_id))) mails++;
    }
  }

  return { annulleret, mails };
}

// --- Andenchance-tilbud --------------------------------------------------------

type TilbudRaekke = {
  id: string;
  auction_id: string;
  oprindelig_trade_id: string;
  seller_id: string;
  byder_id: string;
  bud_oere: number;
  status: string;
  udloeber: string;
  ny_trade_id: string | null;
  byder_mail_sendt_kl: string | null;
  saelger_mail_sendt_kl: string | null;
};

const TILBUD_KOLONNER =
  "id, auction_id, oprindelig_trade_id, seller_id, byder_id, bud_oere, status, udloeber, ny_trade_id, byder_mail_sendt_kl, saelger_mail_sendt_kl";

// Mail til byderen om et nyt tilbud. Sendes kun én gang.
export async function sendTilbudMail(tilbudId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data: t } = await admin
    .from("andenchance_tilbud")
    .select(TILBUD_KOLONNER)
    .eq("id", tilbudId)
    .maybeSingle<TilbudRaekke>();
  if (!t || t.status !== "afventer" || t.byder_mail_sendt_kl) return false;
  if (!(await claimFelt(admin, "andenchance_tilbud", t.id, "byder_mail_sendt_kl"))) return false;
  const o = await titelOgEmails(admin, t.auction_id, [t.byder_id]);
  return sendHandelMail(
    o.email.get(t.byder_id),
    andenchanceTilbudMail(o.titel, Number(t.bud_oere), t.id, t.udloeber),
  );
}

// Mail til sælgeren, når et tilbud er accepteret, afvist eller udløbet.
// Annullerede tilbud (sælger satte varen op igen) giver ingen mail.
export async function sendSaelgerSvarMail(tilbudId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data: t } = await admin
    .from("andenchance_tilbud")
    .select(TILBUD_KOLONNER)
    .eq("id", tilbudId)
    .maybeSingle<TilbudRaekke>();
  if (!t || t.saelger_mail_sendt_kl) return false;
  if (!["accepteret", "afvist", "udloebet"].includes(t.status)) return false;
  if (!(await claimFelt(admin, "andenchance_tilbud", t.id, "saelger_mail_sendt_kl"))) return false;
  const o = await titelOgEmails(admin, t.auction_id, [t.seller_id]);
  const mail =
    t.status === "accepteret" && t.ny_trade_id
      ? saelgerAndenchanceAccepteretMail(o.titel, t.ny_trade_id)
      : saelgerAndenchanceAfslaaetMail(
          o.titel,
          t.oprindelig_trade_id,
          t.status === "afvist" ? "afvist" : "udloebet",
        );
  return sendHandelMail(o.email.get(t.seller_id), mail);
}

// Cron-trin: udløb tilbud og send de mails, der mangler (også efter fejl).
export async function behandlAndenchance(): Promise<{ udloebne: number; mails: number }> {
  const admin = createAdminClient();
  const { data: antal, error } = await admin.rpc("andenchance_udloeb");
  if (error) console.error("andenchance_udloeb fejlede:", error);

  let mails = 0;
  const siden = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: svar } = await admin
    .from("andenchance_tilbud")
    .select("id")
    .in("status", ["accepteret", "afvist", "udloebet"])
    .is("saelger_mail_sendt_kl", null)
    .gte("oprettet", siden)
    .limit(200);
  for (const { id } of svar ?? []) {
    if (await sendSaelgerSvarMail(id as string)) mails++;
  }

  const { data: nye } = await admin
    .from("andenchance_tilbud")
    .select("id")
    .eq("status", "afventer")
    .is("byder_mail_sendt_kl", null)
    .limit(200);
  for (const { id } of nye ?? []) {
    if (await sendTilbudMail(id as string)) mails++;
  }

  return { udloebne: Number(antal ?? 0), mails };
}
