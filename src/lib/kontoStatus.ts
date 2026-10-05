import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

// Må brugeren logge ind? Bruges efter hvert gennemført login (adgangskode,
// to-trins-kode og links i mails via /auth/callback).
export type KontoStatus =
  | { kode: "ok" }
  | { kode: "slettet" }
  | { kode: "suspenderet"; besked: string }
  | { kode: "fejl" };

export async function hentKontoStatus(brugerId: string): Promise<KontoStatus> {
  const { data: profil, error } = await createAdminClient()
    .from("users")
    .select("suspenderet, suspenderet_aarsag, suspenderet_til, konto_slettet_kl")
    .eq("id", brugerId)
    .maybeSingle();
  if (error) {
    console.error("hentKontoStatus: profil kunne ikke hentes:", error.message);
    return { kode: "fejl" };
  }
  if (profil?.konto_slettet_kl) return { kode: "slettet" };

  // Udløbet suspension ignoreres (ryddes af en medarbejder i admin-panelet).
  const aktivSuspension =
    profil?.suspenderet &&
    (!profil.suspenderet_til || new Date(profil.suspenderet_til) > new Date());
  if (aktivSuspension) {
    const varighed = profil.suspenderet_til
      ? `indtil d. ${new Date(profil.suspenderet_til).toLocaleDateString("da-DK", { timeZone: "Europe/Copenhagen" })}`
      : "permanent";
    return {
      kode: "suspenderet",
      besked: `Din konto er suspenderet ${varighed}. Årsag: ${profil.suspenderet_aarsag ?? "Ingen begrundelse angivet"}. Kontakt support@bidhamr.dk, hvis du mener, det er en fejl.`,
    };
  }
  return { kode: "ok" };
}
