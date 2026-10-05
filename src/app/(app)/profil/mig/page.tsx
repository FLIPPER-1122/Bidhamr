import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Min profil", robots: { index: false, follow: false } };

export default async function MinProfilPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    redirect("/login?redirect=/profil/mig");
  }

  redirect(`/profil/${data.user.id}`);
}
