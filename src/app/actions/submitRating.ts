"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

// Kun køberen i en handel må bedømme, og kun handlens sælger, én gang.
// Samme regel håndhæves i RLS (migration 20260925000000_stram_ratings_rls.sql).
// Tjekket her findes for at give en pæn dansk fejlbesked i stedet for en rå
// RLS-fejl – det er ikke sikkerhedslaget.
export async function submitRating(formData: FormData) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return { error: "Du skal være logget ind for at bedømme." };
  }

  const fraId = authData.user.id;
  const tilId = (formData.get("til_bruger_id") as string) ?? "";
  const auktionId = (formData.get("auktion_id") as string) ?? "";
  const stjerner = Number(formData.get("stjerner"));
  const kommentar = ((formData.get("kommentar") as string) ?? "").trim() || null;

  if (!tilId || !auktionId) {
    return { error: "Bedømmelsen mangler oplysninger. Prøv igen." };
  }

  if (fraId === tilId) {
    return { error: "Du kan ikke bedømme dig selv." };
  }

  if (!stjerner || !Number.isInteger(stjerner) || stjerner < 1 || stjerner > 5) {
    return { error: "Vælg venligst 1-5 stjerner." };
  }

  // Var brugeren køber i netop denne handel, og er den bedømte handlens sælger?
  const { data: handel } = await supabase
    .from("trades")
    .select("buyer_id, seller_id")
    .eq("auction_id", auktionId)
    .maybeSingle();

  if (!handel || handel.buyer_id !== fraId) {
    return {
      error: "Du kan kun bedømme sælgeren på en handel, du selv har købt.",
    };
  }

  if (handel.seller_id !== tilId) {
    return { error: "Du kan kun bedømme sælgeren på handlen." };
  }

  const { error } = await supabase.from("ratings").insert({
    fra_bruger_id: fraId,
    til_bruger_id: tilId,
    auktion_id: auktionId,
    stjerner,
    kommentar,
  });

  if (error) {
    // 23505 = unique_violation: brugeren har allerede bedømt denne auktion.
    if (error.code === "23505") {
      return { error: "Du har allerede afgivet en bedømmelse for denne auktion." };
    }
    // 42501 = RLS afviste raden. Sker kun hvis tjekkene ovenfor blev omgået.
    if (error.code === "42501") {
      return {
        error: "Du kan kun bedømme sælgeren på en handel, du selv har købt.",
      };
    }
    return { error: error.message };
  }

  revalidatePath(`/auktion/${auktionId}`);
  revalidatePath(`/profil/${tilId}`);
  return { success: true };
}
