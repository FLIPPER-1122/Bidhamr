import "server-only";

// Beta-testen (docs/BETA-TEST.md, 20261017010000_beta_invitationer.sql).
// Kun til server-kode: bruger service-role-klienten.
//
// - Kontakten "Beta åben/lukket" står i beta_indstillinger.beta_aaben (kun
//   chefen kan ændre den, Admin -> Beta-invitationer).
// - Gaten (src/lib/supabase/middleware.ts) spørger selv min_beta_adgang().
// - Fejler et opslag, svares der "lukket" (fail closed).
import { createAdminClient } from "@/lib/supabase/admin";

// Er beta-testen åben lige nu? Til signup- og login-siden (om der skal vises
// "Opret konto" for inviterede).
export async function betaAaben(): Promise<boolean> {
  try {
    const { data, error } = await createAdminClient()
      .from("beta_indstillinger")
      .select("beta_aaben")
      .eq("id", true)
      .maybeSingle<{ beta_aaben: boolean }>();
    if (error) return false;
    return data?.beta_aaben === true;
  } catch {
    return false;
  }
}

export type AuthBruger = { findes: false } | { findes: true; id: string; bekraeftet: boolean };

// Findes der en auth-bruger med e-mailen (slået op i auth.users), og er den
// bekræftet? null = kunne ikke tjekkes (kalderen rører så intet).
export async function betaAuthBruger(email: string): Promise<AuthBruger | null> {
  try {
    const { data, error } = await createAdminClient().rpc("beta_auth_bruger", { p_email: email });
    if (error) {
      console.error("beta_auth_bruger:", error.message);
      return null;
    }
    const d = (data ?? {}) as { findes?: unknown; id?: unknown; bekraeftet?: unknown };
    if (d.findes === false) return { findes: false };
    if (d.findes === true && typeof d.id === "string") return { findes: true, id: d.id, bekraeftet: d.bekraeftet === true };
    return null;
  } catch (err) {
    console.error("beta_auth_bruger kastede:", err);
    return null;
  }
}

// Må denne e-mail oprette en konto nu (beta åben og aktiv invitation)?
// null = kunne ikke tjekkes (kalderen afviser, fail closed).
export async function betaTilmeldingTilladt(email: string): Promise<boolean | null> {
  try {
    const { data, error } = await createAdminClient().rpc("beta_tilmelding_tilladt", { p_email: email });
    if (error) {
      console.error("beta_tilmelding_tilladt:", error.message);
      return null;
    }
    return data === true;
  } catch (err) {
    console.error("beta_tilmelding_tilladt kastede:", err);
    return null;
  }
}
