"use server";

// Digital Services Act - offentlige handlinger:
//   anmeldIndhold       anmeld ulovligt indhold (art. 16), også uden login
//   klagOverAfgoerelse  den ramte bruger klager over et indgreb (art. 20)
//   klagSomAnmelder     anmelderen klager over, at der ikke blev grebet ind
// Adgang til en sag: indlogget som ejeren ELLER et gyldigt signeret link fra
// mailen (src/lib/dsa/link.ts). Fejl RETURNERES som { fejl }.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { FOR_MANGE_FORSOEG, klientIp, tjekGraenser } from "@/lib/rateLimit";
import { opretAnmeldelse, type AnmeldResultat } from "@/lib/dsa/server";
import { erUuid, tjekDsaToken } from "@/lib/dsa/link";
import { DSA_BEGRUNDELSE_MAKS, DSA_BEGRUNDELSE_MIN } from "@/lib/dsa/regler";

const GENERISK = "Noget gik galt. Prøv igen om lidt.";

async function brugerId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  return user?.id ?? null;
}

export async function anmeldIndhold(formData: FormData): Promise<AnmeldResultat> {
  try {
    return await opretAnmeldelse(
      {
        type: formData.get("type"),
        id: formData.get("id"),
        link: formData.get("link"),
        kategori: formData.get("kategori"),
        begrundelse: formData.get("begrundelse"),
        navn: formData.get("navn"),
        email: formData.get("email"),
        godTro: formData.get("god_tro"),
        honeypot: formData.get("hjemmeside"),
        startet: formData.get("t"),
      },
      { brugerId: await brugerId(), ip: await klientIp(), kilde: "web" },
    );
  } catch (err) {
    console.error("anmeldIndhold fejlede:", err);
    return { kode: "fejl", fejl: GENERISK };
  }
}

const KLAGE_FEJL: Record<string, string> = {
  ikke_logget_ind: "Log ind, eller brug linket i mailen fra os.",
  begrundelse: `Forklar med ${DSA_BEGRUNDELSE_MIN}-${DSA_BEGRUNDELSE_MAKS} tegn, hvorfor du er uenig.`,
  ikke_fundet: "Vi kunne ikke finde sagen. Brug linket i mailen fra os.",
  findes: "Du har allerede klaget over denne afgørelse. Der er kun ét klagetrin.",
  ophaevet: "Afgørelsen er allerede ophævet, så der er intet at klage over.",
  frist_udloebet: "Fristen på 6 måneder for at klage er udløbet.",
  kan_ikke_klage: "Der kan ikke klages over denne afgørelse.",
};

function klageTekst(formData: FormData): string {
  const v = formData.get("begrundelse");
  return typeof v === "string" ? v.trim() : "";
}

// formData: afgoerelseId, t (token fra mailen, valgfri), begrundelse.
export async function klagOverAfgoerelse(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  try {
    const id = String(formData.get("afgoerelseId") ?? "");
    const begrundelse = klageTekst(formData);
    if (!erUuid(id)) return { fejl: KLAGE_FEJL.ikke_fundet };
    if (begrundelse.length < DSA_BEGRUNDELSE_MIN || begrundelse.length > DSA_BEGRUNDELSE_MAKS) {
      return { fejl: KLAGE_FEJL.begrundelse };
    }
    if (!(await tjekGraenser([["dsa_klage_ip", await klientIp()]]))) return { fejl: FOR_MANGE_FORSOEG };

    const admin = createAdminClient();
    const { data: a } = await admin
      .from("dsa_afgoerelser")
      .select("bruger_id")
      .eq("id", id)
      .maybeSingle<{ bruger_id: string }>();
    if (!a) return { fejl: KLAGE_FEJL.ikke_fundet };
    const mig = await brugerId();
    const harAdgang = mig === a.bruger_id || tjekDsaToken("afgoerelse", id, formData.get("t"));
    if (!harAdgang) return { fejl: KLAGE_FEJL.ikke_fundet };

    const { data, error } = await admin.rpc("dsa_klage_indgiv", {
      p_bruger: a.bruger_id,
      p_afgoerelse: id,
      p_begrundelse: begrundelse,
    });
    if (error) {
      console.error("dsa_klage_indgiv fejlede:", error.message);
      return { fejl: GENERISK };
    }
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") return { fejl: KLAGE_FEJL[kode ?? ""] ?? GENERISK };
    revalidatePath(`/dsa/afgoerelse/${id}`);
    revalidatePath("/konto/afgoerelser");
    revalidatePath("/admin/dsa");
    return { ok: true };
  } catch (err) {
    console.error("klagOverAfgoerelse fejlede:", err);
    return { fejl: GENERISK };
  }
}

// formData: anmeldelseId, t (token fra mailen, valgfri), begrundelse.
export async function klagSomAnmelder(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  try {
    const id = String(formData.get("anmeldelseId") ?? "");
    const begrundelse = klageTekst(formData);
    if (!erUuid(id)) return { fejl: KLAGE_FEJL.ikke_fundet };
    if (begrundelse.length < DSA_BEGRUNDELSE_MIN || begrundelse.length > DSA_BEGRUNDELSE_MAKS) {
      return { fejl: KLAGE_FEJL.begrundelse };
    }
    if (!(await tjekGraenser([["dsa_klage_ip", await klientIp()]]))) return { fejl: FOR_MANGE_FORSOEG };

    const admin = createAdminClient();
    const { data: a } = await admin
      .from("dsa_anmeldelser")
      .select("anmelder_id")
      .eq("id", id)
      .maybeSingle<{ anmelder_id: string | null }>();
    if (!a) return { fejl: KLAGE_FEJL.ikke_fundet };
    const mig = await brugerId();
    const harAdgang = (!!mig && mig === a.anmelder_id) || tjekDsaToken("anmeldelse", id, formData.get("t"));
    if (!harAdgang) return { fejl: KLAGE_FEJL.ikke_fundet };

    const { data, error } = await admin.rpc("dsa_klage_indgiv_anmelder", {
      p_anmeldelse: id,
      p_begrundelse: begrundelse,
    });
    if (error) {
      console.error("dsa_klage_indgiv_anmelder fejlede:", error.message);
      return { fejl: GENERISK };
    }
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") return { fejl: KLAGE_FEJL[kode ?? ""] ?? GENERISK };
    revalidatePath(`/dsa/anmeldelse/${id}`);
    revalidatePath("/konto/afgoerelser");
    revalidatePath("/admin/dsa");
    return { ok: true };
  } catch (err) {
    console.error("klagSomAnmelder fejlede:", err);
    return { fejl: GENERISK };
  }
}
