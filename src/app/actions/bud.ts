"use server";

import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { createClient } from "@/lib/supabase/server";
import { klientIp } from "@/lib/rateLimit";
import { afgivBudFor, saetMaksimumFor, type BudFejl } from "@/lib/bud/afgivBud";

// Bud afgives paa serveren, saa det kan rate-limites pr. bruger og pr. IP.
// Selve buddet indsaettes stadig med brugerens egen session, saa RLS
// (bids_insert_own) og triggerne gaelder uaendret. Logikken deles med appen
// (POST /api/bud/app) i src/lib/bud/afgivBud.ts. Fejl RETURNERES.

type Fejl = { fejl: string; auktionAendret?: true; mitid?: true; adresse?: true };

// Hjemmesiden bruger kun teksten og markeringerne - koden er til appen.
function udenKode(f: BudFejl): Fejl {
  return {
    fejl: f.fejl,
    ...(f.auktionAendret ? { auktionAendret: true as const } : {}),
    ...(f.mitid ? { mitid: true as const } : {}),
    ...(f.adresse ? { adresse: true as const } : {}),
  };
}

export async function afgivBud(
  auktionId: string,
  beloeb: number,
  beskyttelse: boolean,
  // auctions.redigeret_kl, som byderen så. Valgfri for bagudkompatibilitet.
  redigeretKl?: string | null,
): Promise<{ ok: true; slutterKl: string | null; foerer: boolean | null; nuvaerendeBud: number | null } | Fejl> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  if (!user) return { fejl: "Du skal være logget ind for at byde." };
  const r = await afgivBudFor(supabase, user.id, await klientIp(), auktionId, beloeb, beskyttelse, redigeretKl);
  return "fejl" in r ? udenKode(r) : r;
}

// Automatisk bud (maksimum) - se ROADMAP-BESLUTNINGER.md, "Autobud".
// Maksimum sendes aldrig til andre end byderen selv.
export async function saetMaksimum(
  auktionId: string,
  maks: number,
  // Ignoreres (20261031010000): BidHamr Beskyttelse er inkluderet i gebyret
  // ved forsendelse - budpanelet sender altid false.
  beskyttelse: boolean,
  redigeretKl?: string | null,
): Promise<
  | { ok: true; foerer: boolean; nuvaerendeBud: number | null; maks: number; slutterKl: string | null; budAfgivet: boolean }
  | Fejl
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  if (!user) return { fejl: "Du skal være logget ind for at byde." };
  const r = await saetMaksimumFor(supabase, user.id, await klientIp(), auktionId, maks, beskyttelse, redigeretKl);
  return "fejl" in r ? udenKode(r) : r;
}
