import type { NextRequest } from "next/server";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  APP_GENERISK,
  APP_IKKE_LOGGET_IND,
  APP_UGYLDIG,
  UUID_RE,
  appBruger,
  appSvar,
  bearerToken,
  fremmedOrigin,
  laesJsonKrop,
} from "@/lib/appApi";
import { sletFjernedeBilleder } from "@/lib/auktionBilledOprydning";

// Auktionshandlinger fra appen. Dokumentation: docs/APP-ENDPOINTS.md.
//
// POST /api/auktion/app/fjern-billeder
//   Authorization: Bearer <Supabase access token>
//   Content-Type: application/json
//   { auktion_id, stier: string[] }   (højst 20; storage-stier "<bruger-id>/<fil>.jpg"
//                                      eller de offentlige URL'er)
//   200 { ok: true }
//   409 { fejl, kode: "sag_aaben" }  en åben DSA-sag/rapport om NOGEN af brugerens auktioner
//   400 ugyldig · 401 ikke_logget_ind · 403 ikke_ejer · 404 ikke_fundet · 429 · 500
//
// Kaldes efter en redigering (rpc rediger_auktion), hvor sælgeren har fjernet
// billeder. Samme oprydning som hjemmesidens redigerAuktion
// (src/lib/auktionBilledOprydning.ts): kun filer i ejerens egen mappe, kun
// filer, som ingen af ejerens auktioner bruger (tjekket i databasen), og
// intet slettes, mens der er en åben DSA-anmeldelse, rapport eller klage om
// NOGEN af ejerens auktioner (409 sag_aaben). Kun ejeren af auktionen.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HANDLINGER = ["fjern-billeder"] as const;
const MAKS_STIER = 20;

export async function POST(req: NextRequest, { params }: { params: Promise<{ handling: string }> }) {
  const { handling } = await params;
  if (!(HANDLINGER as readonly string[]).includes(handling)) {
    return appSvar(404, { fejl: "Ukendt handling.", kode: "ugyldig" });
  }
  if (fremmedOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["auktion_app_ip", ip]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const token = bearerToken(req);
  if (!token) return appSvar(401, APP_IKKE_LOGGET_IND);

  const k = await laesJsonKrop(req, 8192);
  if ("svar" in k) return k.svar;
  const { auktion_id: auktionId, stier } = k.krop;
  if (typeof auktionId !== "string" || !UUID_RE.test(auktionId)) return appSvar(400, APP_UGYLDIG);
  if (
    !Array.isArray(stier) ||
    stier.length > MAKS_STIER ||
    !stier.every((s) => typeof s === "string" && s.length > 0 && s.length <= 1000)
  ) {
    return appSvar(400, APP_UGYLDIG);
  }

  const login = await appBruger(token);
  if (!login) return appSvar(401, APP_IKKE_LOGGET_IND);
  const { bruger } = login;
  if (!(await tjekGraenser([["auktion_app_bruger", bruger.id]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  try {
    // Ejerskab: kun sælgeren af auktionen (også en skjult eller arkiveret).
    const { data: auktion, error } = await createAdminClient()
      .from("auctions")
      .select("id, bruger_id")
      .eq("id", auktionId)
      .maybeSingle<{ id: string; bruger_id: string }>();
    if (error) throw new Error(`auctions: ${error.message}`);
    if (!auktion) return appSvar(404, { fejl: "Auktionen findes ikke.", kode: "ikke_fundet" });
    if (auktion.bruger_id !== bruger.id) {
      return appSvar(403, { fejl: "Det er ikke din auktion.", kode: "ikke_ejer" });
    }
    // helBruger: en åben sag om NOGEN af brugerens auktioner (eller brugeren
    // selv) stopper hele kaldet - så et andet auktion_id ikke kan bruges til
    // at slette bevis.
    const r = await sletFjernedeBilleder(bruger.id, auktion.id, stier as string[], { helBruger: true });
    if (r.kode === "sag_aaben") {
      return appSvar(409, {
        fejl: "Billederne kan ikke slettes lige nu, fordi BidHamr behandler en sag om en af dine auktioner.",
        kode: "sag_aaben",
      });
    }
    if (r.kode === "fejl") return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
    return appSvar(200, { ok: true });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: `/api/auktion/app/${handling}`, fejl: err, brugerId: bruger.id });
    return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
  }
}
