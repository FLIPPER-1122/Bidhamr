import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { klientIp } from "@/lib/rateLimit";
import { normaliserSti } from "@/lib/statistikSti";

// Cookiefri besøgsstatistik. Modtager en sidevisning fra Sidevisning.tsx
// (navigator.sendBeacon) og tæller den op i sidevisninger (pr. dag + sti).
// Der gemmes INTET om den besøgende: ingen cookies, intet bruger-id, ingen IP,
// ingen user agent. IP bruges kun i hukommelsen til en simpel rate-limit og
// glemmes igen. Svarer altid 204, så en fejl her aldrig mærkes af brugeren.
//
// Offentlig rute (OFFENTLIGE_RUTER i src/lib/supabase/middleware.ts), så også
// besøg på venteliste-siden tælles. Beskyttelse: kun kendte sidetyper gemmes
// (normaliserSti), rate-limit pr. IP, og kun kald fra vores eget domæne.

const VINDUE_MS = 60_000;
const MAKS_PR_VINDUE = 30;
const MAKS_NOEGLER = 5_000;
const taeller = new Map<string, { antal: number; nulstilles: number }>();

function indenForGraense(ip: string, nu: number): boolean {
  if (taeller.size > MAKS_NOEGLER) {
    for (const [k, v] of taeller) if (v.nulstilles <= nu) taeller.delete(k);
    if (taeller.size > MAKS_NOEGLER) taeller.clear();
  }
  const t = taeller.get(ip);
  if (!t || t.nulstilles <= nu) {
    taeller.set(ip, { antal: 1, nulstilles: nu + VINDUE_MS });
    return true;
  }
  t.antal += 1;
  return t.antal <= MAKS_PR_VINDUE;
}

function svar() {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  // Do Not Track / Global Privacy Control respekteres også på serveren.
  if (req.headers.get("dnt") === "1" || req.headers.get("sec-gpc") === "1") return svar();

  // Kun fra vores egne sider (sendBeacon sender Origin med).
  const origin = req.headers.get("origin");
  if (!origin || origin !== req.nextUrl.origin) return svar();

  if (!indenForGraense(await klientIp(), Date.now())) return svar();

  let raa: unknown;
  try {
    const tekst = await req.text();
    if (tekst.length > 1_000) return svar();
    raa = (JSON.parse(tekst) as { sti?: unknown })?.sti;
  } catch {
    return svar();
  }

  const sti = normaliserSti(raa);
  if (!sti) return svar();

  try {
    const { error } = await createAdminClient().rpc("registrer_sidevisning", { p_sti: sti });
    if (error) console.error("[statistik] kunne ikke gemme sidevisning:", error.message);
  } catch (err) {
    console.error("[statistik] kunne ikke gemme sidevisning:", err);
  }
  return svar();
}
