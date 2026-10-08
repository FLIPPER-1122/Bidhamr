"use server";

// Sælgeren forlænger betalingsfristen (ROADMAP-BESLUTNINGER.md,
// "Betalingsfrist", 5. oktober 2026). Alle regler håndhæves i databasen
// (handel_forlaeng_betalingsfrist): kun sælgeren, kun mens handlen afventer
// betaling, mindst 24 timer senere end den nuværende frist (eller lig med den
// sidste mulige frist), højst 7 dage efter, at betalingsfristen startede, og
// højst 3 forlængelser pr. handel. Appen kalder samme RPC direkte.
//
// Ingen penge flyttes: kun fristen i betalinger.betal_senest ændres.

import { after } from "next/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { notificerFristForlaengelser } from "@/lib/notifikationer/cron";
import { fristDato } from "@/lib/betalingsfrist";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Svar = { kode: string; betal_senest?: string; maks_frist?: string };

export async function forlaengBetalingsfrist(
  tradeId: string,
  nyFrist: string,
): Promise<{ ok: true; betalSenest: string } | { fejl: string }> {
  if (typeof tradeId !== "string" || !UUID.test(tradeId)) {
    return { fejl: "Handlen findes ikke." };
  }
  const ms = typeof nyFrist === "string" ? Date.parse(nyFrist) : NaN;
  if (!Number.isFinite(ms)) return { fejl: "Vælg en ny frist." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  if (!user) return { fejl: "Du skal være logget ind." };

  const { data, error } = await supabase.rpc("handel_forlaeng_betalingsfrist", {
    p_trade: tradeId,
    p_ny_frist: new Date(ms).toISOString(),
  });
  if (error) {
    console.error("handel_forlaeng_betalingsfrist fejlede:", error);
    return { fejl: "Fristen kunne ikke forlænges. Prøv igen om lidt." };
  }

  const svar = (data ?? { kode: "fejl" }) as Svar;
  switch (svar.kode) {
    case "ok":
      // Køberen får besked med det samme. Cron'en tager den, hvis det fejler.
      after(() => notificerFristForlaengelser());
      revalidatePath(`/mine-handler/${tradeId}`);
      return { ok: true, betalSenest: svar.betal_senest ?? new Date(ms).toISOString() };
    case "ikke_logget_ind":
      return { fejl: "Du skal være logget ind." };
    case "ikke_fundet":
      return { fejl: "Handlen findes ikke." };
    case "ikke_afventer":
      return { fejl: "Handlen venter ikke længere på betaling." };
    case "venter_paa_saelgerkonto":
      return {
        fejl: "Køberen kan ikke betale endnu, fordi din konto hos Stripe ikke er godkendt. Fristen starter, når kontoen er godkendt.",
      };
    case "frist_udloebet":
      return { fejl: "Fristen er allerede udløbet og kan ikke forlænges." };
    case "for_mange":
      return { fejl: "Fristen er allerede forlænget 3 gange og kan ikke forlænges igen." };
    case "ugyldig_frist":
      return {
        fejl: "Den nye frist skal være mindst 24 timer senere end den nuværende (eller den sidste mulige frist).",
      };
    case "for_sent":
      return {
        fejl: svar.maks_frist
          ? `Fristen kan højst forlænges til ${fristDato(svar.maks_frist)}.`
          : "Fristen kan højst forlænges til 7 dage efter, at betalingsfristen startede.",
      };
    default:
      return { fejl: "Fristen kunne ikke forlænges. Prøv igen om lidt." };
  }
}
