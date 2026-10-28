import type { NextRequest } from "next/server";
import { FOR_MANGE_FORSOEG, klientIpNoegle, tjekGraenser } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { APP_GENERISK, APP_IKKE_LOGGET_IND, APP_UGYLDIG, appBruger, appSvar, bearerToken, fremmedOrigin, laesJsonKrop } from "@/lib/appApi";
import { createAdminClient } from "@/lib/supabase/admin";
import { iapKlar } from "@/lib/iap/konfig";
import { laesIapKrop } from "@/lib/iap/regler";
import { IAP_TEKST, iapProdukter, iapSpaerret, koebIApp } from "@/lib/iap/server";

// Køb af boost-point i appen via Apple In-App Purchase og Google Play
// Billing (Filip, 27. okt. 2026). Dokumentation: docs/APP-ENDPOINTS.md
// ("Køb af boost-point i appen") og docs/IAP.md.
//
// GET /api/app/boost/iap   Authorization: Bearer <token> (valgfri)
//   200 { ok: true, klar: { ios, android }, produkter: [{ id, point }],
//         kanKoebe?: boolean, grund?: "erhverv" | "spaerret" | null,
//         appAccountToken?: uuid }
//   klar.<platform> = false: skjul køb i appen på den platform.
//
// POST /api/app/boost/iap   Authorization: Bearer <token>   Content-Type: application/json
//   { platform: "ios", signedTransaction }                     (StoreKit 2: Transaction.jwsRepresentation)
//   { platform: "android", productId, purchaseToken }          (Play Billing: Purchase.getPurchaseToken())
//   200 { ok: true, kode: "ok" | "allerede", point, saldo }    afslut transaktionen i appen
//   400 ugyldig  401 ikke_logget_ind  403 erhverv | spaerret | ikke_tilladt
//   409 anden_konto | refunderet | annulleret | afventer | forkert_miljoe | produkt_ukendt | ikke_forbrug | antal
//   422 ugyldigt_koeb  429 for_mange  500 fejl  503 iap_ikke_klar | proev_igen

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const MAKS_KROP = 64 * 1024;

export async function GET(req: NextRequest) {
  if (fremmedOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });
  if (!(await tjekGraenser([["iap_status_ip", await klientIpNoegle()]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }
  try {
    const admin = createAdminClient();
    const produkter = await iapProdukter(admin);
    const k = iapKlar();
    // Uden produkter (migrationen er ikke kørt) er intet klar.
    const klar = { ios: k.ios && produkter.length > 0, android: k.android && produkter.length > 0 };
    const token = bearerToken(req);
    if (!token) return appSvar(200, { ok: true, klar, produkter });
    const login = await appBruger(token);
    if (!login) return appSvar(401, APP_IKKE_LOGGET_IND);
    const spaerret = await iapSpaerret(admin, login.bruger.id);
    return appSvar(200, {
      ok: true,
      klar,
      produkter,
      kanKoebe: spaerret === null,
      grund: spaerret === "erhverv" ? "erhverv" : spaerret ? "spaerret" : null,
      // Sættes som appAccountToken (iOS) / obfuscatedAccountId (Android) ved
      // købet, så serveren kan se, at købet hører til denne konto.
      appAccountToken: login.bruger.id,
    });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/app/boost/iap", hvor: "boost/iap-status", fejl: err });
    return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
  }
}

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });
  if (!(await tjekGraenser([["iap_ip", await klientIpNoegle()]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }
  const token = bearerToken(req);
  if (!token) return appSvar(401, APP_IKKE_LOGGET_IND);
  const login = await appBruger(token);
  if (!login) return appSvar(401, APP_IKKE_LOGGET_IND);
  const brugerId = login.bruger.id;
  if (!(await tjekGraenser([["iap_bruger", brugerId]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const k = await laesJsonKrop(req, MAKS_KROP);
  if ("svar" in k) return k.svar;
  const krop = laesIapKrop(k.krop);
  if (!krop) return appSvar(400, APP_UGYLDIG);

  const klar = iapKlar();
  if (!klar[krop.platform]) return appSvar(503, { fejl: IAP_TEKST.iap_ikke_klar, kode: "iap_ikke_klar" });

  try {
    const r = await koebIApp(brugerId, krop);
    if (r.ok) return appSvar(200, { ok: true, kode: r.kode, point: r.point, saldo: r.saldo });
    return appSvar(r.status, { fejl: r.fejl, kode: r.kode });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/app/boost/iap", hvor: "boost/iap-koeb", fejl: err, brugerId });
    return appSvar(500, { fejl: IAP_TEKST.fejl, kode: "fejl" });
  }
}
