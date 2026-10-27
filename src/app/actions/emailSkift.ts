"use server";

// Skift af e-mail på hjemmesiden (Indstillinger). Logikken deles med appen
// (POST /api/konto/email og /api/konto/email/bekraeft) i
// src/lib/emailSkift.ts - her med brugerens cookie-session. Brugeren udledes
// altid af sessionen (getUser), aldrig af klienten. Fejl RETURNERES som
// { fejl }.
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { logDriftFejl } from "@/lib/drift";
import { EMAIL_SKIFT, anmodEmailSkiftFor, bekraeftEmailSkiftFor } from "@/lib/emailSkift";

const IKKE_LOGGET_IND = "Du er ikke logget ind længere. Log ind igen.";

type Fejl = { fejl: string };

export async function sendEmailSkiftKode(nyEmail: string, adgangskode: string): Promise<{ ok: true; besked: string } | Fejl> {
  try {
    const supabase = await createClient();
    const { data } = await hentLoggetIndBruger(supabase);
    if (!data.user) return { fejl: IKKE_LOGGET_IND };
    const r = await anmodEmailSkiftFor({ bruger: data.user, nyEmail, adgangskode });
    if ("fejl" in r) return { fejl: r.fejl };
    return { ok: true, besked: r.besked };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "sendEmailSkiftKode", fejl: err });
    return { fejl: EMAIL_SKIFT.generisk };
  }
}

export async function bekraeftEmailSkift(kode: string): Promise<{ ok: true; email: string } | Fejl> {
  try {
    const supabase = await createClient();
    const { data } = await hentLoggetIndBruger(supabase);
    if (!data.user) return { fejl: IKKE_LOGGET_IND };
    const r = await bekraeftEmailSkiftFor({
      bruger: data.user,
      kode,
      logUdAndre: async () => (await supabase.auth.signOut({ scope: "others" })).error,
    });
    if ("fejl" in r) return { fejl: r.fejl };
    // Ny JWT med den nye e-mail i cookien (sessionen selv er den samme).
    const { error: friskFejl } = await supabase.auth.refreshSession();
    if (friskFejl) console.error("bekraeftEmailSkift: sessionen kunne ikke fornyes:", friskFejl.message);
    revalidatePath("/konto");
    revalidatePath("/profil/[id]", "page");
    return { ok: true, email: r.email };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "bekraeftEmailSkift", fejl: err });
    return { fejl: EMAIL_SKIFT.generisk };
  }
}
