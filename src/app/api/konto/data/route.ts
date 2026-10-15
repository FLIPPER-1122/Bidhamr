import { NextResponse, type NextRequest } from "next/server";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { APP_GENERISK, APP_IKKE_LOGGET_IND, appBruger, appSvar, bearerToken, fremmedOrigin } from "@/lib/appApi";
import { lavMineDataFil } from "@/lib/mineDataFil";

// "Download dine data" (GDPR) fra appen - Bearer-varianten af /konto/data.
// Samme kode (src/lib/mineDataFil.ts) og samme databasekald (mine_data(),
// højst én fil i timen, delt med hjemmesiden). Dokumentation:
// docs/APP-ENDPOINTS.md.
//
// POST /api/konto/data?format=pdf   (uden format: JSON-filen)
//   Authorization: Bearer <Supabase access token>
//   200 application/pdf (eller application/json) med Content-Disposition: attachment
//   401 { fejl, kode: "ikke_logget_ind" }   403 { fejl, kode: "ikke_tilladt" }
//   429 { fejl, kode: "vent" }        allerede hentet inden for den sidste time (BHR01)
//   429 { fejl, kode: "for_mange" }   500 { fejl, kode: "fejl" }
// POST (ikke GET), så et link eller prefetch ikke kan bruge timens udtræk.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["konto_data_app_ip", ip]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const token = bearerToken(req);
  if (!token) return appSvar(401, APP_IKKE_LOGGET_IND);
  const login = await appBruger(token);
  if (!login) return appSvar(401, APP_IKKE_LOGGET_IND);

  const somPdf = req.nextUrl.searchParams.get("format") === "pdf";
  try {
    const fil = await lavMineDataFil(login.supabase, login.bruger.id, somPdf, "/api/konto/data");
    if ("fejl" in fil) {
      if (fil.fejl === "vent") {
        return appSvar(429, { fejl: "Du kan hente dine data én gang i timen. Prøv igen senere.", kode: "vent" });
      }
      return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
    }
    const krop =
      typeof fil.indhold === "string"
        ? fil.indhold
        : new Blob([fil.indhold as Uint8Array<ArrayBuffer>], { type: fil.type });
    return new NextResponse(krop, {
      status: 200,
      headers: {
        "Content-Type": fil.type,
        "Content-Disposition": `attachment; filename="${fil.filnavn}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/konto/data", fejl: err, brugerId: login.bruger.id });
    return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
  }
}
