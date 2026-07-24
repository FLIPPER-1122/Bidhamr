"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function submitRating(formData: FormData) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return { error: "Du skal være logget ind for at bedømme." };
  }

  const fraId = authData.user.id;
  const tilId = formData.get("til_bruger_id") as string;
  const auktionId = formData.get("auktion_id") as string;
  const stjerner = Number(formData.get("stjerner"));
  const kommentar = (formData.get("kommentar") as string).trim() || null;

  if (fraId === tilId) {
    return { error: "Du kan ikke bedømme dig selv." };
  }

  if (!stjerner || stjerner < 1 || stjerner > 5) {
    return { error: "Vælg venligst 1-5 stjerner." };
  }

  const { error } = await supabase.from("ratings").insert({
    fra_bruger_id: fraId,
    til_bruger_id: tilId,
    auktion_id: auktionId,
    stjerner,
    kommentar,
  });

  if (error) {
    if (error.code === "23505") {
      return { error: "Du har allerede afgivet en bedømmelse for denne auktion." };
    }
    return { error: error.message };
  }

  revalidatePath(`/auktion/${auktionId}`);
  revalidatePath(`/profil/${tilId}`);
  return { success: true };
}
