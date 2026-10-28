import "server-only";

import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { appleKonfig, googleKonfig, type AppleKonfig, type GoogleKonfig } from "@/lib/iap/konfig";
import { hentAppleTransaktion, verificerAppleNotifikation, verificerAppleTransaktion } from "@/lib/iap/apple";
import { forbrugGoogleKoeb, hentGoogleKoeb, hentGoogleVoided, verificerPubSubToken } from "@/lib/iap/google";
import {
  appleRefunderetAndel,
  laesGoogleRtdn,
  vurderAppleTransaktion,
  vurderGoogleKoeb,
  type IapFejlKode,
  type IapKoeb,
  type IapKrop,
} from "@/lib/iap/regler";

// Køb af boost-point i appen (Filip, 27. okt. 2026). Migration
// 20261102320000_boost_iap.sql. Opsætning: docs/IAP.md. Appens kontrakt:
// docs/APP-ENDPOINTS.md.
//
// Pengene: Apple/Google opkræver køberen (de er sælger, opkræver moms og
// udsteder kvitteringen) og udbetaler BidHamr efter deres gebyr. BidHamr
// rører aldrig pengene her og laver ingen faktura - serveren krediterer kun
// point, når Apple/Google har bekræftet købet:
//   iOS:     appens signerede transaktion verificeres (kæden til Apple Root
//            CA - G3, bundle, miljø), og købet slås op igen hos Apple (Get
//            Transaction Info) - Apples svar er sandheden (refunderet?).
//   Android: købet slås op hos Google (purchases.products.get): betalt, ikke
//            annulleret, rigtigt miljø og antal. Efter krediteringen kaldes
//            consume, så produktet kan købes igen.
// Krediteringen er idempotent i databasen (boost_iap_krediter): samme
// transaktion/ordre/token giver aldrig point to gange eller til en anden
// bruger. Refusion: webhooks (Apple REFUND, Google voidedPurchaseNotification)
// og den daglige cron (Googles Voided Purchases API) trækker pointene
// tilbage (boost_iap_refusion) - saldoen må gå i minus, og chefen får en
// drift-alarm.

type Admin = ReturnType<typeof createAdminClient>;

export type IapSvar =
  | { ok: true; kode: "ok" | "allerede"; point: number | null; saldo: number }
  | { ok: false; status: number; kode: IapFejlKode | "iap_ikke_klar" | "erhverv" | "spaerret" | "proev_igen" | "fejl"; fejl: string };

export const IAP_TEKST: Record<string, string> = {
  iap_ikke_klar: "Køb i appen er ikke muligt lige nu.",
  ugyldig: "Ugyldig forespørgsel.",
  ugyldigt_koeb: "Købet kunne ikke bekræftes hos Apple eller Google.",
  forkert_miljoe: "Købet er et testkøb og kan ikke bruges her.",
  produkt_ukendt: "Produktet findes ikke.",
  ikke_forbrug: "Produktet kan ikke bruges til boost-point.",
  antal: "Køb én pakke ad gangen.",
  afventer: "Betalingen er ikke gennemført endnu. Dine point kommer, når den er gennemført.",
  annulleret: "Købet er annulleret.",
  refunderet: "Købet er refunderet og giver ikke point.",
  anden_konto: "Købet er lavet på en anden BidHamr-konto.",
  erhverv: "Boost er kun for private sælgere. Firmakonti kan ikke købe eller bruge boost.",
  spaerret: "Din konto kan ikke bruge boost lige nu. Kontakt BidHamr, hvis du har spørgsmål.",
  proev_igen: "Vi kunne ikke nå Apple eller Google. Prøv igen om lidt – dit køb er ikke tabt.",
  fejl: "Noget gik galt. Prøv igen om lidt – dit køb er ikke tabt.",
};

const STATUS: Record<string, number> = {
  iap_ikke_klar: 503,
  ugyldig: 400,
  ugyldigt_koeb: 422,
  forkert_miljoe: 409,
  produkt_ukendt: 409,
  ikke_forbrug: 409,
  antal: 409,
  afventer: 409,
  annulleret: 409,
  refunderet: 409,
  anden_konto: 409,
  erhverv: 403,
  spaerret: 403,
  proev_igen: 503,
  fejl: 500,
};

function nej(kode: Extract<IapSvar, { ok: false }>["kode"]): IapSvar {
  return { ok: false, status: STATUS[kode] ?? 500, kode, fejl: IAP_TEKST[kode] ?? IAP_TEKST.fejl };
}

export function manglerMigration(fejl: { code?: string } | null | undefined): boolean {
  return fejl?.code === "PGRST202" || fejl?.code === "42883" || fejl?.code === "42P01" || fejl?.code === "PGRST205";
}

// Kun det korte id i logs (aldrig tokens eller hele kvitteringer).
const kort = (s: string) => (s.length > 24 ? `${s.slice(0, 12)}…${s.slice(-6)}` : s);
export const tokenHash = (t: string) => createHash("sha256").update(t, "utf8").digest("hex").slice(0, 40);

// De aktive produkt-id'er og point (GET /api/app/boost/iap). [] hvis
// migrationen ikke er kørt.
export async function iapProdukter(admin: Admin = createAdminClient()): Promise<{ id: string; point: number }[]> {
  const { data, error } = await admin
    .from("boost_iap_produkter")
    .select("produkt_id, point")
    .eq("aktiv", true)
    .order("sortering");
  if (error) {
    if (!manglerMigration(error)) await logDriftFejl({ kilde: "server", sti: "/api/app/boost/iap", hvor: "boost/iap-produkter", fejl: error.message });
    return [];
  }
  return ((data ?? []) as { produkt_id: string; point: number }[]).map((p) => ({ id: p.produkt_id, point: p.point }));
}

// null = må købe; ellers 'erhverv' | 'spaerret' | 'ikke_fundet'.
export async function iapSpaerret(admin: Admin, brugerId: string): Promise<string | null> {
  const { data, error } = await admin.rpc("boost_bruger_spaerret", { p_bruger: brugerId });
  if (error) throw new Error(`boost_bruger_spaerret: ${error.code ?? ""} ${error.message}`);
  return (data as string | null) ?? null;
}

type KrediterSvar = { kode: string; id?: string; point?: number; saldo?: number; forbrugt?: boolean; refunderet?: boolean };

async function krediter(admin: Admin, brugerId: string, k: IapKoeb): Promise<KrediterSvar> {
  const { data, error } = await admin.rpc("boost_iap_krediter", {
    p_bruger: brugerId,
    p_platform: k.platform,
    p_ekstern_id: k.eksternId,
    p_original_id: k.originalId,
    p_google_token: k.googleToken,
    p_produkt: k.produktId,
    p_miljoe: k.miljoe,
    p_koebt_kl: k.koebtKl,
    p_pris_milli: k.prisMilli,
    p_valuta: k.valuta,
    p_land: k.land,
  });
  if (error) throw new Error(`boost_iap_krediter: ${error.code ?? ""} ${error.message}`);
  return (data ?? { kode: "fejl" }) as KrediterSvar;
}

function krediterSvar(r: KrediterSvar): IapSvar {
  switch (r.kode) {
    case "ok":
    case "allerede":
      return { ok: true, kode: r.kode, point: typeof r.point === "number" ? r.point : null, saldo: Number(r.saldo ?? 0) };
    case "anden_bruger":
      return nej("anden_konto");
    case "erhverv":
      return nej("erhverv");
    case "spaerret":
    case "ikke_fundet":
      return nej("spaerret");
    case "produkt_ukendt":
      return nej("produkt_ukendt");
    default:
      return nej("fejl");
  }
}

// POST /api/app/boost/iap - selve købet. brugerId er verificeret (Bearer).
export async function koebIApp(brugerId: string, krop: IapKrop, admin: Admin = createAdminClient()): Promise<IapSvar> {
  const sti = "/api/app/boost/iap";
  // Firma/spærret: afvis, før vi spørger Apple/Google (købet afsluttes ikke,
  // og Google refunderer et køb, der ikke er forbrugt inden 3 dage).
  const spaerret = await iapSpaerret(admin, brugerId);
  if (spaerret === "erhverv") return nej("erhverv");
  if (spaerret) return nej("spaerret");

  if (krop.platform === "ios") {
    const k = appleKonfig();
    if (!k) return nej("iap_ikke_klar");
    return koebApple(admin, k, brugerId, krop.signedTransaction, sti);
  }
  const g = googleKonfig();
  if (!g) return nej("iap_ikke_klar");
  return koebGoogle(admin, g, brugerId, krop.productId, krop.purchaseToken, sti);
}

async function koebApple(admin: Admin, k: AppleKonfig, brugerId: string, jws: string, sti: string): Promise<IapSvar> {
  // 1. Appens signerede transaktion (kun for at finde id og miljø).
  const fraApp = await verificerAppleTransaktion(k, jws);
  if ("fejl" in fraApp) {
    if (fraApp.fejl === "midlertidig") return nej("proev_igen");
    return nej(fraApp.fejl === "miljoe" ? "forkert_miljoe" : "ugyldigt_koeb");
  }
  const id = fraApp.tx.transactionId;
  if (!id || !/^\d{1,30}$/.test(id)) return nej("ugyldigt_koeb");
  // 2. Sandheden fra Apple (Get Transaction Info).
  const hos = await hentAppleTransaktion(k, id, fraApp.miljoe);
  if ("fejl" in hos) {
    if (hos.fejl === "midlertidig") {
      await logDriftFejl({ kilde: "server", sti, hvor: "boost/iap-apple", fejl: hos.grund, brugerId });
      return nej("proev_igen");
    }
    return nej(hos.fejl === "miljoe" ? "forkert_miljoe" : "ugyldigt_koeb");
  }
  if (hos.tx.transactionId !== id || hos.tx.productId !== fraApp.tx.productId) return nej("ugyldigt_koeb");
  const v = vurderAppleTransaktion(hos.tx, { bundleId: k.bundleId, brugerId, tilladte: k.tilladte });
  if (!v.ok) return nej(v.kode);
  return krediterSvar(await krediter(admin, brugerId, v.data));
}

async function koebGoogle(
  admin: Admin,
  g: GoogleKonfig,
  brugerId: string,
  produktId: string,
  token: string,
  sti: string,
): Promise<IapSvar> {
  const hos = await hentGoogleKoeb(g, produktId, token);
  if ("fejl" in hos) {
    if (hos.fejl === "ugyldig") return nej("ugyldigt_koeb");
    await logDriftFejl({ kilde: "server", sti, hvor: "boost/iap-google", fejl: hos.grund, brugerId });
    return nej("proev_igen");
  }
  const v = vurderGoogleKoeb(hos.koeb, {
    produktId,
    brugerId,
    tilladTestkoeb: g.tilladTestkoeb,
    token,
    tokenHash: tokenHash(token),
  });
  if (!v.ok) return nej(v.kode);
  const { forbrugt, ...koeb } = v.data;
  const r = await krediter(admin, brugerId, koeb);
  const svar = krediterSvar(r);
  // Consume efter krediteringen (også ved 'allerede', hvis det fejlede sidst).
  if (svar.ok && r.id && !r.forbrugt) await forbrug(admin, g, r.id, produktId, token, forbrugt, sti);
  return svar;
}

async function forbrug(
  admin: Admin,
  g: GoogleKonfig,
  koebId: string,
  produktId: string,
  token: string,
  alleredeForbrugt: boolean,
  sti: string,
): Promise<boolean> {
  const r = alleredeForbrugt ? ({ ok: true } as const) : await forbrugGoogleKoeb(g, produktId, token);
  const ok = "ok" in r;
  const { error } = await admin.rpc("boost_iap_forbrug_resultat", {
    p_id: koebId,
    p_ok: ok,
    p_fejl: ok ? null : r.grund,
  });
  if (error) await logDriftFejl({ kilde: "server", sti, hvor: "boost/iap-forbrug", fejl: error.message });
  if (!ok) {
    // Pointene er krediteret; cron'en prøver igen. Uden consume (eller
    // acknowledge) inden 3 dage refunderer Google købet - og så trækkes
    // pointene tilbage af sig selv.
    await logDriftFejl({ kilde: "server", sti, hvor: "boost/iap-forbrug", fejl: `Google consume fejlede for køb ${koebId}: ${r.grund}` });
  }
  return ok;
}

// ---------------------------------------------------------------- refusion

type RefusionSvar = { kode: string; bruger_id?: string; point?: number; saldo?: number; i_minus?: boolean; id?: string };

async function refunder(
  admin: Admin,
  platform: "ios" | "android",
  eksternId: string | null,
  token: string | null,
  andelMilli: number,
  kilde: "apple_notifikation" | "google_rtdn" | "google_voided",
  sti: string,
): Promise<string> {
  const { data, error } = await admin.rpc("boost_iap_refusion", {
    p_platform: platform,
    p_ekstern_id: eksternId,
    p_google_token: token,
    p_andel_milli: andelMilli,
    p_kilde: kilde,
  });
  if (error) throw new Error(`boost_iap_refusion: ${error.code ?? ""} ${error.message}`);
  const r = (data ?? { kode: "fejl" }) as RefusionSvar;
  const navn = platform === "ios" ? "Apple" : "Google";
  if (r.kode === "tilbagefoert" && r.i_minus) {
    // Drift-alarm til chefen: saldoen er i minus (pointene var brugt).
    await logDriftFejl({
      kilde: "server",
      sti,
      hvor: "boost/iap-minus",
      fejl: `${navn} har refunderet et køb af boost-point (køb ${r.id}). ${r.point} point er trukket tilbage, og brugerens saldo er nu ${r.saldo} point (i minus). Nye boost er blokeret, til saldoen er positiv. Se Admin → brugeren → Boost-point.`,
      brugerId: r.bruger_id,
    });
  } else if (r.kode === "ukendt") {
    // Fx et firmakøb, der aldrig blev krediteret og derfor blev refunderet.
    console.info(`IAP: ${navn} refunderede et køb, vi ikke har krediteret (${kort(eksternId ?? token ?? "")}).`);
  }
  return r.kode;
}

// ----------------------------------------------------------- webhooks

type Start = "ny" | "gentaget" | "behandlet";

async function notifikationStart(admin: Admin, platform: "ios" | "android", id: string, type: string): Promise<Start> {
  const { data, error } = await admin.rpc("boost_iap_notifikation_start", { p_platform: platform, p_id: id, p_type: type });
  if (error) throw new Error(`boost_iap_notifikation_start: ${error.code ?? ""} ${error.message}`);
  return data as Start;
}

async function notifikationSlut(admin: Admin, platform: "ios" | "android", id: string, resultat: string) {
  const { error } = await admin.rpc("boost_iap_notifikation_slut", { p_platform: platform, p_id: id, p_resultat: resultat });
  if (error) throw new Error(`boost_iap_notifikation_slut: ${error.code ?? ""} ${error.message}`);
}

async function note(admin: Admin, platform: "ios" | "android", eksternId: string, tekst: string): Promise<string | null> {
  const { data, error } = await admin.rpc("boost_iap_opmaerksomhed", { p_platform: platform, p_ekstern_id: eksternId, p_tekst: tekst });
  if (error) throw new Error(`boost_iap_opmaerksomhed: ${error.code ?? ""} ${error.message}`);
  return (data as string | null) ?? null;
}

export type WebhookSvar = { status: number; resultat: string };

// POST /api/webhooks/apple - App Store Server Notifications V2.
// 200 = modtaget (også for typer, vi ikke bruger). 401 = ikke verificeret.
// 500 = midlertidig fejl (Apple prøver igen: 1, 12, 24, 48 og 72 timer).
export async function haandterAppleNotifikation(signedPayload: string, admin: Admin = createAdminClient()): Promise<WebhookSvar> {
  const sti = "/api/webhooks/apple";
  const k = appleKonfig();
  if (!k) return { status: 503, resultat: "iap_ikke_klar" };
  const v = await verificerAppleNotifikation(k, signedPayload);
  if ("fejl" in v) {
    if (v.fejl === "miljoe") return { status: 200, resultat: "andet_miljoe" };
    if (v.fejl === "midlertidig") return { status: 500, resultat: "proev_igen" };
    return { status: 401, resultat: "ugyldig" };
  }
  const n = v.notifikation;
  const type = n.notificationType ?? "ukendt";
  const id = n.notificationUUID;
  if (!id || !/^[0-9a-f-]{8,64}$/i.test(id)) return { status: 401, resultat: "ugyldig" };
  if ((await notifikationStart(admin, "ios", id, type)) === "behandlet") return { status: 200, resultat: "allerede" };

  let resultat = "ignoreret";
  if (type === "TEST") {
    resultat = "test";
  } else if (type === "REFUND" || type === "REFUND_REVERSED" || type === "CONSUMPTION_REQUEST") {
    const s = n.data?.signedTransactionInfo;
    if (!s) {
      resultat = "uden_transaktion";
    } else {
      const t = await verificerAppleTransaktion(k, s);
      if ("fejl" in t) {
        if (t.fejl === "midlertidig") return { status: 500, resultat: "proev_igen" };
        resultat = "ugyldig_transaktion";
      } else if (!t.tx.transactionId || t.tx.bundleId !== k.bundleId) {
        resultat = "ugyldig_transaktion";
      } else if (type === "REFUND") {
        resultat = await refunder(admin, "ios", t.tx.transactionId, null, appleRefunderetAndel(t.tx), "apple_notifikation", sti);
      } else if (type === "REFUND_REVERSED") {
        // Apple har trukket en refusion tilbage (fx efter en tvist). Pointene
        // gives ikke automatisk igen - chefen kan justere.
        const bruger = await note(admin, "ios", t.tx.transactionId,
          "Apple har trukket refusionen tilbage (REFUND_REVERSED) - køberen har betalt igen. Pointene er ikke givet tilbage automatisk; chefen kan justere dem.");
        if (bruger) {
          await logDriftFejl({
            kilde: "server",
            sti,
            hvor: "boost/iap-refusion-tilbage",
            fejl: `Apple har trukket en refusion af boost-point tilbage (transaktion ${kort(t.tx.transactionId)}). Giv evt. pointene igen under Admin → brugeren → Boost-point.`,
            brugerId: bruger,
          });
        }
        resultat = bruger ? "noteret" : "ukendt";
      } else {
        // CONSUMPTION_REQUEST: køberen har bedt Apple om en refusion. Vi har
        // ikke køberens samtykke til at dele forbrugsdata, så vi svarer ikke
        // Apple (Apples vejledning: uden samtykke - svar ikke). Kun en note.
        const bruger = await note(admin, "ios", t.tx.transactionId,
          `Køberen har bedt Apple om en refusion (CONSUMPTION_REQUEST${n.data?.consumptionRequestReason ? `, ${n.data.consumptionRequestReason}` : ""}). Apple afgør sagen; pointene trækkes tilbage, hvis Apple refunderer.`);
        resultat = bruger ? "noteret" : "ukendt";
      }
    }
  }
  await notifikationSlut(admin, "ios", id, resultat);
  return { status: 200, resultat };
}

// POST /api/webhooks/google-play - Pub/Sub push med RTDN.
// 204 = modtaget. 401 = OIDC-tokenet er ikke verificeret. 500 = prøv igen.
export async function haandterGoogleRtdn(
  authorization: string | null,
  krop: Record<string, unknown>,
  admin: Admin = createAdminClient(),
): Promise<WebhookSvar> {
  const sti = "/api/webhooks/google-play";
  const g = googleKonfig();
  if (!g) return { status: 503, resultat: "iap_ikke_klar" };
  if (!(await verificerPubSubToken(g, authorization))) return { status: 401, resultat: "ugyldig" };
  const besked = krop.message as Record<string, unknown> | undefined;
  const id = typeof besked?.messageId === "string" ? besked.messageId : typeof besked?.message_id === "string" ? besked.message_id : null;
  if (!besked || !id || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || typeof besked.data !== "string" || besked.data.length > 20000) {
    // Ægte (verificeret), men ikke en RTDN, vi kan læse - kvittér, så Pub/Sub
    // ikke prøver igen i en uendelighed.
    return { status: 204, resultat: "ulaeselig" };
  }
  let n: unknown;
  try {
    n = JSON.parse(Buffer.from(besked.data, "base64").toString("utf8"));
  } catch {
    return { status: 204, resultat: "ulaeselig" };
  }
  const r = laesGoogleRtdn(n, g.pakke);
  if (!r) return { status: 204, resultat: "anden_app" };
  const type = r.slags === "void" ? "voidedPurchaseNotification" : r.slags === "test" ? "testNotification" : "andet";
  if ((await notifikationStart(admin, "android", id, type)) === "behandlet") return { status: 204, resultat: "allerede" };
  let resultat = r.slags === "test" ? "test" : "ignoreret";
  if (r.slags === "void" && r.engangskoeb) {
    // Vi tillader kun ét stk. pr. køb, så en void er hele købet.
    resultat = await refunder(admin, "android", r.orderId, r.purchaseToken, 100000, "google_rtdn", sti);
  }
  await notifikationSlut(admin, "android", id, resultat);
  return { status: 204, resultat };
}

// ------------------------------------------------------------- cron

// Dagligt (claimet i databasen, kaldt fra betalings-cron'en hvert 5. minut):
//   1. Googles Voided Purchases (de seneste 3 døgn) - sikkerhedsnet, hvis en
//      RTDN er gået tabt. Refusionen er idempotent.
//   2. Consume igen for Google-køb, hvor det fejlede.
// null = ikke sat op (ingen Google-konfiguration) eller ikke tid endnu.
export async function koerIapCron(admin: Admin = createAdminClient()): Promise<{
  voided: number;
  tilbagefoert: number;
  forbrugt: number;
  fejl: number;
} | null> {
  const g = googleKonfig();
  if (!g) return null;
  const { data: claim, error } = await admin.rpc("boost_iap_cron_claim", { p_timer: 20 });
  if (error) {
    if (manglerMigration(error)) return null;
    throw new Error(`boost_iap_cron_claim: ${error.code ?? ""} ${error.message}`);
  }
  if (claim !== true) return null;
  const sti = "boost-iap-cron";
  let tilbagefoert = 0;
  let forbrugt = 0;
  let fejl = 0;

  const v = await hentGoogleVoided(g, Date.now() - 3 * 24 * 3600 * 1000);
  if ("fejl" in v) {
    fejl++;
    await logDriftFejl({ kilde: "cron", sti, hvor: "boost/iap-voided", fejl: v.grund });
  } else {
    for (const x of v.koeb) {
      try {
        if ((await refunder(admin, "android", x.orderId, x.purchaseToken, 100000, "google_voided", sti)) === "tilbagefoert") tilbagefoert++;
      } catch (err) {
        fejl++;
        await logDriftFejl({ kilde: "cron", sti, hvor: "boost/iap-voided", fejl: err });
      }
    }
  }

  const { data: mangler, error: mErr } = await admin.rpc("boost_iap_mangler_forbrug", { p_graense: 50 });
  if (mErr) {
    fejl++;
    await logDriftFejl({ kilde: "cron", sti, hvor: "boost/iap-forbrug", fejl: mErr.message });
  } else {
    for (const m of (mangler ?? []) as { id: string; produkt_id: string; google_token: string }[]) {
      if (await forbrug(admin, g, m.id, m.produkt_id, m.google_token, false, sti)) forbrugt++;
      else fejl++;
    }
  }
  if (fejl === 0) await admin.rpc("boost_iap_cron_ok");
  return { voided: "koeb" in v ? v.koeb.length : 0, tilbagefoert, forbrugt, fejl };
}
