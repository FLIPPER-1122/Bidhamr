import "server-only";

import { getErhvervRolle } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";

// Browsertitler på Erhvervs detaljesider, så fanen hedder det samme som
// overskriften. Slår kun navnet op efter rolletjekket (chef/sælger); ellers
// en neutral titel. Kun de kolonner, titlen bruger.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function admin() {
  return (await getErhvervRolle()) ? createAdminClient() : null;
}

export async function henvendelseTitel(id: string): Promise<string> {
  const db = UUID.test(id) ? await admin() : null;
  if (!db) return "Henvendelse";
  const { data } = await db.from("erhverv_henvendelser").select("firmanavn").eq("id", id).maybeSingle<{ firmanavn: string }>();
  return data?.firmanavn ?? "Henvendelse";
}

export async function firmaTitel(id: string): Promise<string> {
  const db = UUID.test(id) ? await admin() : null;
  if (!db) return "Firma";
  const { data } = await db.from("firmaer").select("firmanavn").eq("id", id).maybeSingle<{ firmanavn: string }>();
  return data?.firmanavn ?? "Firma";
}

export async function klageTitel(id: string): Promise<string> {
  const db = UUID.test(id) ? await admin() : null;
  if (!db) return "Klage";
  const { data } = await db.from("erhverv_klager").select("nummer, firma_id").eq("id", id).maybeSingle<{ nummer: number; firma_id: string }>();
  if (!data) return "Klage";
  const { data: f } = await db.from("firmaer").select("firmanavn").eq("id", data.firma_id).maybeSingle<{ firmanavn: string }>();
  return `Klage nr. ${data.nummer}${f?.firmanavn ? ` · ${f.firmanavn}` : ""}`;
}

export async function dsaKlageTitel(id: string): Promise<string> {
  const db = UUID.test(id) ? await admin() : null;
  if (!db) return "Firmaers klager (DSA)";
  const { data } = await db.from("dsa_klager").select("sagsnummer, afgoerelse_id").eq("id", id).maybeSingle<{ sagsnummer: string; afgoerelse_id: string | null }>();
  if (!data) return "Firmaers klager (DSA)";
  let firma: string | null = null;
  if (data.afgoerelse_id) {
    const { data: a } = await db.from("dsa_afgoerelser").select("bruger_id").eq("id", data.afgoerelse_id).maybeSingle<{ bruger_id: string }>();
    if (a) {
      const { data: f } = await db.from("firmaer").select("firmanavn").eq("bruger_id", a.bruger_id).maybeSingle<{ firmanavn: string }>();
      firma = f?.firmanavn ?? null;
    }
  }
  return `${data.sagsnummer} · ${firma ?? "Firma"}`;
}
