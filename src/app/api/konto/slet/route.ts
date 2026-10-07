import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { udfoerKontoSletning, SLET_GENERISK } from "@/lib/kontoSletning";
import { logDriftFejl } from "@/lib/drift";

// Kontosletning direkte i appen (Apples krav 5.1.1(v)). Samme regler og
// samme kode som "Slet konto" på hjemmesiden (src/lib/kontoSletning.ts).
//
// POST /api/konto/slet
//   Authorization: Bearer <Supabase access token>
//   Content-Type: application/json
//   { "adgangskode": "...", "bekraeftelse": "SLET" }
//
// Svar (JSON):
//   200 { ok: true }
//   400 { fejl, kode: "bekraeftelse" | "ugyldig" }
//   401 { fejl, kode: "ikke_logget_ind" }
//   403 { fejl, kode: "forkert_adgangskode" | "ikke_tilladt" }
//   409 { fejl, kode: "blokeret", blokeringer: [{ type, tekst, link }] }
//   429 { fejl, kode: "for_mange" }
//   500 { fejl, kode: "fejl" }
//
// Sikkerhed:
// - Kun Bearer-token - cookies bruges ikke, så en fremmed hjemmeside kan ikke
//   få en indlogget browser til at slette kontoen (ingen CSRF).
// - Ingen CORS-headere: browsere på andre domæner kan ikke kalde endpointet
//   (Authorization-headeren kræver preflight, som ikke godkendes). Forespørgsler
//   med en fremmed Origin afvises desuden. Appen (native) sender ingen Origin.
// - Adgangskoden og "SLET" kræves, og der er rate limits pr. bruger og IP.
//
// Proxyen lukker denne sti igennem uden cookie-login (src/lib/supabase/middleware.ts);
// adgangskontrollen sker udelukkende her.

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
  if (fremmedOrigin(req)) {
    return svar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });
  }

  const ip = await klientIp();
  if (!(await tjekGraenser([["konto_slet_ip", ip]]))) {
    return svar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(auth.trim());
  if (!m) {
    return svar(401, { fejl: "Du er ikke logget ind længere. Log ind igen.", kode: "ikke_logget_ind" });
  }
  const token = m[1];

  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return svar(400, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
  }
  let krop: { adgangskode?: unknown; bekraeftelse?: unknown };
  try {
    const raa = await req.text();
    if (raa.length > 4096) return svar(400, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
    krop = JSON.parse(raa) as typeof krop;
    if (!krop || typeof krop !== "object") throw new Error("ikke et objekt");
  } catch {
    return svar(400, { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" });
  }

  // Klient med brugerens token - kun til at validere tokenet.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
  const { data: brugerData, error: brugerFejl } = await supabase.auth.getUser(token);
  const bruger = brugerData?.user;
  if (brugerFejl || !bruger) {
    return svar(401, { fejl: "Du er ikke logget ind længere. Log ind igen.", kode: "ikke_logget_ind" });
  }

  try {
    const res = await udfoerKontoSletning({
      bruger,
      adgangskode: krop.adgangskode,
      bekraeftelse: krop.bekraeftelse,
      logUdAlleSteder: async () => {
        const { error } = await createAdminClient().auth.admin.signOut(token, "global");
        if (error) throw error;
      },
    });
    if ("ok" in res) return svar(200, { ok: true });
    const status =
      res.kode === "bekraeftelse" ? 400
      : res.kode === "forkert_adgangskode" ? 403
      : res.kode === "blokeret" ? 409
      : res.kode === "for_mange" ? 429
      : 500;
    return svar(status, { fejl: res.fejl, kode: res.kode, ...(res.blokeringer ? { blokeringer: res.blokeringer } : {}) });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/konto/slet", fejl: err, brugerId: bruger.id });
    return svar(500, { fejl: SLET_GENERISK, kode: "fejl" });
  }
}
