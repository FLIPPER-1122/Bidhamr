import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { profilFaneQuery } from "@/lib/profilFaner";

export const metadata: Metadata = { title: "Min profil", robots: { index: false, follow: false } };

// Sender videre til /profil/<id>. ?fane= og ?vis= tages med, så fx
// /profil/mig?fane=handler (Mine handler) virker fra menuer og mails.
export default async function MinProfilPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = profilFaneQuery(await searchParams);
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    redirect(`/login?redirect=${encodeURIComponent(`/profil/mig${query}`)}`);
  }

  redirect(`/profil/${data.user.id}${query}`);
}
