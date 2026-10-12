"use server";

// Admin -> Penge (KUN chef): "Markér som løst" på en afvigelse fra den daglige
// afstemning. Flytter ingen penge.
// Rollen tjekkes her (assertRole("chef")) og igen i databasen
// (staff_chat_har_rolle(p_chef, 'chef')).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";

function tilbage(besked: string): never {
  revalidatePath("/admin/penge");
  redirect(`/admin/penge?besked=${encodeURIComponent(besked)}#oekonomi`);
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
