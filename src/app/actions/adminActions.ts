"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

async function assertAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Ikke logget ind");

  const { data: profile } = await supabase
    .from("users")
    .select("rolle")
    .eq("id", user.id)
    .single();

  if (!profile || profile.rolle !== "admin") {
    throw new Error("Ingen adgang");
  }

  return supabase;
}

export async function suspendUser(formData: FormData) {
  const userId = formData.get("userId") as string;
  const supabase = await assertAdmin();

  await supabase
    .from("users")
    .update({ rolle: "suspenderet" })
    .eq("id", userId);

  revalidatePath("/admin/brugere");
}

export async function deleteAuction(formData: FormData) {
  const auktionId = formData.get("auktionId") as string;
  const supabase = await assertAdmin();

  await supabase.from("auctions").delete().eq("id", auktionId);

  revalidatePath("/admin/auktioner");
}

export async function cancelAuction(formData: FormData) {
  const auktionId = formData.get("auktionId") as string;
  const supabase = await assertAdmin();

  await supabase
    .from("auctions")
    .update({ status: "annulleret" })
    .eq("id", auktionId);

  revalidatePath("/admin/auktioner");
}

export async function deleteRating(formData: FormData) {
  const ratingId = formData.get("ratingId") as string;
  const supabase = await assertAdmin();

  await supabase.from("ratings").delete().eq("id", ratingId);

  revalidatePath("/admin/bedommelser");
}
