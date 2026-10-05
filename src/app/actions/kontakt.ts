"use server";

// Kontaktformularen (/kontakt). Henvendelsen gemmes i kontakt_henvendelser
// med service-role (ingen browser-adgang til tabellen) og vises i
// /admin/kontakt. Spambeskyttelse: honeypot-felt, minimumstid på siden og
// rate-limit pr. IP, bruger, e-mail og samlet. Fejl RETURNERES.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { FOR_MANGE_FORSOEG, klientIp, tjekGraenser } from "@/lib/rateLimit";
import {
  erKontaktEmne,
  KONTAKT_BESKED_MAKS,
  KONTAKT_BESKED_MIN,
} from "@/lib/tryghed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Udfyldes formularen hurtigere end dette, er det næsten altid en robot.
const MIN_SEKUNDER = 3;

export async function sendKontakt(
  formData: FormData,
): Promise<{ ok: true } | { fejl: string }> {
  try {
    // Honeypot: feltet er skjult for mennesker. Robotten får "ok", så den
    // ikke prøver igen med et andet felt.
    if (String(formData.get("hjemmeside") ?? "").trim() !== "") return { ok: true };
    // Mangler tidsfeltet eller er det ugyldigt, behandles det som for hurtigt
    // (formularen sætter det altid) – ellers kunne en robot bare udelade det.
    // Et menneske, der er hurtigt (fx indsat tekst), må ikke tro, at beskeden
    // er sendt: derfor en synlig besked i stedet for et stille "ok".
    const raa = formData.get("t");
    const start = typeof raa === "string" && /^\d{1,16}$/.test(raa) ? Number(raa) : NaN;
    if (!Number.isFinite(start) || start <= 0 || Date.now() - start < MIN_SEKUNDER * 1000) {
      return { fejl: "Vent et øjeblik, og prøv igen." };
    }

    const emne = String(formData.get("emne") ?? "");
    const besked = String(formData.get("besked") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    const ref = String(formData.get("handel") ?? "").trim();

    if (!erKontaktEmne(emne)) return { fejl: "Vælg et emne." };
    if (!EMAIL.test(email) || email.length > 254) {
      return { fejl: "Skriv en gyldig e-mailadresse, så vi kan svare dig." };
    }
    if (besked.length < KONTAKT_BESKED_MIN) {
      return { fejl: "Skriv lidt mere, så vi kan hjælpe dig." };
    }
    if (besked.length > KONTAKT_BESKED_MAKS) {
      return { fejl: `Beskeden må højst være ${KONTAKT_BESKED_MAKS.toLocaleString("da-DK")} tegn.` };
    }
    if (ref.length > 100) return { fejl: "Handels-id'et er for langt." };

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const ip = await klientIp();
    const graenser: Parameters<typeof tjekGraenser>[0] = [
      ["kontakt_ip", ip],
      ["kontakt_email", email],
      ["kontakt_alle", "alle"],
    ];
    if (user) graenser.push(["kontakt_bruger", user.id]);
    if (!(await tjekGraenser(graenser))) return { fejl: FOR_MANGE_FORSOEG };

    // Handlen knyttes kun, hvis det er en handel, brugeren selv er part i
    // (RLS på trades). Ellers gemmes det indtastede blot som tekst.
    let tradeId: string | null = null;
    if (user && UUID.test(ref)) {
      const { data } = await supabase
        .from("trades")
        .select("id")
        .eq("id", ref)
        .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
        .maybeSingle<{ id: string }>();
      tradeId = data?.id ?? null;
    }

    const { error } = await createAdminClient().from("kontakt_henvendelser").insert({
      bruger_id: user?.id ?? null,
      email,
      emne,
      besked,
      handels_ref: ref || null,
      trade_id: tradeId,
    });
    if (error) {
      console.error("Kontaktformular kunne ikke gemmes:", error.message);
      return { fejl: "Beskeden kunne ikke sendes lige nu. Prøv igen om lidt, eller skriv til support@bidhamr.dk." };
    }
    return { ok: true };
  } catch (err) {
    console.error("sendKontakt fejlede:", err);
    return { fejl: "Beskeden kunne ikke sendes lige nu. Prøv igen om lidt, eller skriv til support@bidhamr.dk." };
  }
}
