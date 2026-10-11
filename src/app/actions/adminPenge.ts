"use server";

// Admin -> Penge (KUN chef): reservens konfiguration og "Markér som løst" på
// en afvigelse fra den daglige afstemning. Ingen af dem flytter penge.
// Rollen tjekkes her (assertRole("chef")) og igen i databasen
// (staff_chat_har_rolle(p_chef, 'chef')).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";

function tal(v: FormDataEntryValue | null): number | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s/g, "").replace(",", ".");
  if (s === "") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Kroner (med komma) -> øre (heltal).
function oere(v: FormDataEntryValue | null): number | null {
  const n = tal(v);
  if (n === null || n < 0) return null;
  return Math.round(n * 100);
}

function tilbage(besked: string): never {
  revalidatePath("/admin/penge");
  redirect(`/admin/penge?besked=${encodeURIComponent(besked)}#oekonomi`);
}

export async function gemPengeKonfiguration(formData: FormData): Promise<void> {
  const { admin, userId } = await assertRole("chef");
  const procent = tal(formData.get("procent"));
  const dage = tal(formData.get("periode_dage"));
  const minimum = oere(formData.get("minimum_kr"));
  const tab = oere(formData.get("forventet_tab_kr"));
  const slaaetTil = formData.get("slaaet_til") === "ja";
  if (procent === null || procent < 0 || procent > 100 || dage === null || !Number.isInteger(dage) || minimum === null || tab === null) {
    tilbage("ugyldig");
  }
  const { data, error } = await admin.rpc("admin_penge_konfiguration_gem", {
    p_chef: userId,
    p_slaaet_til: slaaetTil,
    p_procent: Math.round(procent! * 100) / 100,
    p_periode_dage: dage,
    p_minimum_oere: minimum,
    p_forventet_tab_oere: tab,
  });
  if (error) {
    console.error("admin_penge_konfiguration_gem:", error.message);
    tilbage("fejl");
  }
  tilbage(data === "ok" ? "gemt" : String(data));
}

export async function loesPengeAfvigelse(formData: FormData): Promise<void> {
  const { admin, userId } = await assertRole("chef");
  const id = formData.get("id");
  const note = formData.get("note");
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id) || typeof note !== "string") tilbage("ugyldig");
  const { data, error } = await admin.rpc("admin_penge_afvigelse_loes", {
    p_chef: userId,
    p_id: id,
    p_note: (note as string).slice(0, 1000),
  });
  if (error) {
    console.error("admin_penge_afvigelse_loes:", error.message);
    tilbage("fejl");
  }
  tilbage(data === "ok" ? "loest" : String(data));
}
