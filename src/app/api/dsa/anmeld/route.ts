import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { manglerToTrin } from "@/lib/mfa";
import { klientIp } from "@/lib/rateLimit";
import { opretAnmeldelse } from "@/lib/dsa/server";
import { logDriftFejl } from "@/lib/drift";

// Anmeld ulovligt indhold fra appen (DSA art. 16). Samme regler og kode som
// formularen på hjemmesiden (src/lib/dsa/server.ts → opretAnmeldelse).
//
// POST /api/dsa/anmeld
//   Authorization: Bearer <Supabase access token>   (valgfri - uden login er ok)
//   Content-Type: application/json
//   {
//     "type": "auktion" | "profil" | "spoergsmaal" | "spoergsmaal_svar"
//             | "bedoemmelse" | "bedoemmelse_svar",   (eller udelad og send "link")
//     "id": "<uuid>",            (auktion-, bruger-, spørgsmåls- eller bedømmelses-id;
//                                 ved svar på en bedømmelse: bedømmelsens id)
//     "link": "https://...",     (kun når type/id ikke kendes)
//     "kategori": "forbudt_vare" | "falske_varer" | "svindel" | "ophavsret"
//                 | "personoplysninger" | "hadefuld_tale" | "misbrug_boern"
//                 | "vilkaar" | "andet",
//     "begrundelse": "10-2000 tegn",
//     "navn": "...", "email": "...",   (kræves uden login, undtagen misbrug_boern;
//                                       med login bruges kontoens navn og e-mail)
//     "god_tro": true
//   }
//
// Svar: 200 { ok: true, sagsnummer, statusSti }
//       400 { fejl, kode }   429 { fejl, kode: "for_mange" }   500 { fejl, kode: "fejl" }
//
// Ingen CORS-headere; forespørgsler med en fremmed Origin afvises.
// TODO Filip/sikkerhed: /api/dsa skal på listen over offentlige ruter i
// src/lib/supabase/middleware.ts, før appen kan bruge den uden login.

export const dynamic = "force-dynamic";

function svar(status: number, krop: Record<string, unknown>) {
  return NextResponse.json(krop, { status, headers: { "Cache-Control": "no-store" } });
}

function fremmedOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const vaert = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host !== vaert;
  } catch {
    return true;
  }
}

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return svar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return svar(400, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
  }
  let krop: Record<string, unknown>;
  try {
    const raa = await req.text();
    if (raa.length > 8192) return svar(400, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
    krop = JSON.parse(raa) as Record<string, unknown>;
    if (!krop || typeof krop !== "object") throw new Error("ikke et objekt");
  } catch {
    return svar(400, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
  }

  // Login er valgfrit. Sendes et token, skal det være gyldigt.
  let brugerId: string | null = null;
  const auth = (req.headers.get("authorization") ?? "").trim();
  if (auth) {
    const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(auth);
    if (!m) return svar(401, { fejl: "Du er ikke logget ind længere. Log ind igen.", kode: "ikke_logget_ind" });
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
    );
    const { data, error } = await supabase.auth.getUser(m[1]);
    if (error || !data.user) {
      return svar(401, { fejl: "Du er ikke logget ind længere. Log ind igen.", kode: "ikke_logget_ind" });
    }
    if (await manglerToTrin(supabase, data.user, m[1])) {
      return svar(403, { fejl: "Indtast først koden fra din godkendelses-app.", kode: "to_trin_kraeves" });
    }
    brugerId = data.user.id;
  }

  try {
    const res = await opretAnmeldelse(
      {
        type: krop.type,
        id: krop.id,
        link: krop.link,
        kategori: krop.kategori,
        begrundelse: krop.begrundelse,
        navn: krop.navn,
        email: krop.email,
        godTro: krop.god_tro,
      },
      { brugerId, ip: await klientIp(), kilde: "app" },
    );
    if ("ok" in res) return svar(200, { ok: true, sagsnummer: res.sagsnummer, statusSti: res.statusSti });
    return svar(res.kode === "for_mange" ? 429 : res.kode === "fejl" ? 500 : 400, { fejl: res.fejl, kode: res.kode });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/dsa/anmeld", fejl: err, brugerId });
    return svar(500, { fejl: "Noget gik galt. Prøv igen om lidt.", kode: "fejl" });
  }
}
