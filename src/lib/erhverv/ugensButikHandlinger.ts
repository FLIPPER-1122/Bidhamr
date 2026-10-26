import "server-only";
import { createClient } from "@/lib/supabase/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { FOR_MANGE_FORSOEG, indenForGraense } from "@/lib/rateLimit";
import {
  annullerEgenUgensButik,
  startUgensButikKoeb,
  type UgensButikAnnuller,
  type UgensButikStart,
} from "@/lib/betaling/ugensButik";

// Ugens butik i Firma oversigt. Kaldes KUN fra /api/offentlig/[handling]
// (firma-ugens-butik-koeb, firma-ugens-butik-annuller) - ikke som server
// actions, fordi firmakonti før lancering ikke må kalde server actions (se
// src/lib/supabase/middleware.ts). Route handleren har allerede tjekket
// Origin og kroppens størrelse; her tjekkes login og rate limit. Firmaet
// findes ud fra den indloggede bruger (aldrig fra et felt i kroppen) -
// databasen tjekker igen, at det er en aktiv firmakonto.

async function indlogget(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  return user?.id ?? null;
}

export async function koebUgensButik(uge: string | undefined): Promise<UgensButikStart> {
  const brugerId = await indlogget();
  if (!brugerId) return { fejl: "Du skal være logget ind.", kode: "ugyldig" };
  if (!(await indenForGraense("ugens_butik_firma", brugerId))) return { fejl: FOR_MANGE_FORSOEG, kode: "fejl" };
  return startUgensButikKoeb(brugerId, uge);
}

export async function annullerUgensButik(bookingId: string | undefined): Promise<UgensButikAnnuller> {
  const brugerId = await indlogget();
  if (!brugerId) return { fejl: "Du skal være logget ind.", kode: "ikke_fundet" };
  if (!(await indenForGraense("ugens_butik_firma", brugerId))) return { fejl: FOR_MANGE_FORSOEG, kode: "fejl" };
  return annullerEgenUgensButik(brugerId, bookingId);
}
