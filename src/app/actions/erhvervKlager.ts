"use server";

// Køberens klage over et firma (reklamation, fase 7). Alle regler håndhæves i
// databasen (erhverv_klage_opret - security definer, køberen udledes af
// auth.uid(); én åben klage pr. handel; rate limit). Her laves kun
// forhåndstjek. Fejl RETURNERES som { fejl } (Next skjuler kastede fejl i
// produktion).
//
// Billeder uploades af klienten direkte til Storage (bucket
// 'erhverv-klage-billeder', privat) FØR klagen oprettes, i køberens egen
// mappe <id>/<handel-id>/... Storage-policyen tillader kun upload på en
// handel, køberen må klage over.
//
// Firmaer kalder ingen server actions (før lancering - se
// ROADMAP-BESLUTNINGER, "Erhvervskonti", Teknisk). Firmaets egen liste læses
// i en server component via firma_klager().
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { logDriftFejl } from "@/lib/drift";
import {
  KLAGE_BESKRIVELSE_MAKS,
  KLAGE_BESKRIVELSE_MIN,
  KLAGE_MAKS_BILLEDER,
  erKlageKategori,
  klageFejlTekst,
} from "@/lib/erhverv/klager";
import { KLAGE_KOEBER as T } from "@/lib/tekster/erhvervKlager";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STI = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,100}$/;

function rensStier(stier: unknown): string[] | null {
  if (!Array.isArray(stier) || stier.length > KLAGE_MAKS_BILLEDER) return null;
  const ud: string[] = [];
  for (const s of stier) {
    if (typeof s !== "string" || !STI.test(s) || ud.includes(s)) return null;
    ud.push(s);
  }
  return ud;
}

export async function opretErhvervKlage(
  tradeId: string,
  kategori: string,
  beskrivelse: string,
  billeder: string[],
): Promise<{ ok: true; nummer: number } | { fejl: string }> {
  try {
    if (typeof tradeId !== "string" || !UUID.test(tradeId)) return { fejl: T.fejlGenerisk };
    if (!erKlageKategori(kategori)) return { fejl: T.vaelgKategori };
    const tekst = typeof beskrivelse === "string" ? beskrivelse.trim() : "";
    if (tekst.length < KLAGE_BESKRIVELSE_MIN || tekst.length > KLAGE_BESKRIVELSE_MAKS) {
      return { fejl: T.forKortBeskrivelse(KLAGE_BESKRIVELSE_MIN, KLAGE_BESKRIVELSE_MAKS) };
    }
    const stier = rensStier(billeder ?? []);
    if (!stier) return { fejl: "Et billede er ugyldigt. Fjern det, og prøv igen." };

    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: "Du skal være logget ind." };
    // Stierne skal ligge i køberens egen mappe på denne handel (databasen
    // tjekker det samme igen).
    if (stier.some((s) => !s.startsWith(`${user.id}/${tradeId}/`))) {
      return { fejl: "Et billede er ugyldigt. Fjern det, og prøv igen." };
    }

    const { data, error } = await supabase.rpc("erhverv_klage_opret", {
      p_trade: tradeId,
      p_kategori: kategori,
      p_beskrivelse: tekst,
      p_billeder: stier.map((sti) => ({ sti })),
    });
    if (error) {
      const kendt = klageFejlTekst(error.message, error.code);
      if (kendt) return { fejl: kendt };
      console.error("erhverv_klage_opret fejlede:", error);
      await logDriftFejl({ kilde: "action", sti: "erhverv-klager", hvor: "erhverv_klage_opret", fejl: error, brugerId: user.id });
      return { fejl: T.fejlGenerisk };
    }
    const svar = data as { kode?: string; nummer?: number } | null;
    if (svar?.kode !== "ok") return { fejl: T.fejlGenerisk };

    revalidatePath(`/mine-handler/${tradeId}`);
    revalidatePath("/admin/erhverv/klager");
    return { ok: true, nummer: Number(svar.nummer ?? 0) };
  } catch (err) {
    unstable_rethrow(err);
    console.error("opretErhvervKlage fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "erhverv-klager", hvor: "opretErhvervKlage", fejl: err });
    return { fejl: T.fejlGenerisk };
  }
}

export async function traekErhvervKlageTilbage(klageId: string): Promise<{ ok: true } | { fejl: string }> {
  try {
    if (typeof klageId !== "string" || !UUID.test(klageId)) return { fejl: T.fejlGenerisk };
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: "Du skal være logget ind." };

    const { data, error } = await supabase.rpc("erhverv_klage_traek_tilbage", { p_klage: klageId });
    if (error) {
      const kendt = klageFejlTekst(error.message, error.code);
      if (kendt) return { fejl: kendt };
      console.error("erhverv_klage_traek_tilbage fejlede:", error);
      await logDriftFejl({ kilde: "action", sti: "erhverv-klager", hvor: "erhverv_klage_traek_tilbage", fejl: error, brugerId: user.id });
      return { fejl: T.fejlGenerisk };
    }
    const tradeId = (data as { trade_id?: string } | null)?.trade_id;
    if (tradeId) revalidatePath(`/mine-handler/${tradeId}`);
    revalidatePath("/admin/erhverv/klager");
    // 'afsluttet' (dobbeltklik / allerede afgjort) er også ok - siden opdateres.
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    console.error("traekErhvervKlageTilbage fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "erhverv-klager", hvor: "traekErhvervKlageTilbage", fejl: err });
    return { fejl: T.fejlGenerisk };
  }
}
