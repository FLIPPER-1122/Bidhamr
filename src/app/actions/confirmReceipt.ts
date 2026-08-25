"use server";

import { createClient } from "@/lib/supabase/server";
import { releaseFundsToSeller } from "@/lib/payout";
import { revalidatePath } from "next/cache";

export async function confirmReceipt(auktionId: string) {
  if (!auktionId) {
    return { error: "Mangler auktion." };
  }

  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return { error: "Du skal være logget ind." };
  }

  const { data: transaktion } = await supabase
    .from("transactions")
    .select("id, køber_id, beløb, sælger_gebyr, status")
    .eq("auktion_id", auktionId)
    .eq("status", "betalt")
    .maybeSingle()
    .overrideTypes<
      {
        id: string;
        køber_id: string;
        beløb: number;
        sælger_gebyr: number;
        status: string;
      },
      { merge: false }
    >();

  if (!transaktion) {
    return { error: "Der findes ingen betalt transaktion for denne auktion." };
  }

  if (transaktion.køber_id !== authData.user.id) {
    return { error: "Kun køberen kan bekræfte modtagelse." };
  }

  const { udbetalingBeløb } = await releaseFundsToSeller({
    id: transaktion.id,
    beløb: Number(transaktion.beløb),
    sælger_gebyr: Number(transaktion.sælger_gebyr),
  });

  // Statusguard gør handlingen idempotent ved dobbeltklik.
  const { error } = await supabase
    .from("transactions")
    .update({
      status: "frigivet",
      udbetaling_beløb: udbetalingBeløb,
      udbetalt_kl: new Date().toISOString(),
    })
    .eq("id", transaktion.id)
    .eq("status", "betalt");

  if (error) {
    return { error: error.message };
  }

  revalidatePath(`/auktion/${auktionId}`);
  return { success: true };
}
