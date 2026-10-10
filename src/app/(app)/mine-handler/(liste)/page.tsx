import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { hentBruger } from "@/lib/supabase/bruger";
import { profilFaneQuery } from "@/lib/profilFaner";

export const metadata: Metadata = { title: "Mine handler", robots: { index: false, follow: false } };

// "Mine handler" er en fane på egen profil (/profil/<id>?fane=handler). Denne
// adresse sender videre, så links i mails, notifikationer og appen virker.
// Den enkelte handel (/mine-handler/<id>) og betal-siden ligger stadig her.
export default async function MineHandlerPage({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string }>;
}) {
  const query = profilFaneQuery({ fane: "handler", vis: (await searchParams).vis });
  const user = await hentBruger();
  if (!user) {
    redirect(`/login?redirect=${encodeURIComponent(`/profil/mig${query}`)}`);
  }
  redirect(`/profil/${user.id}${query}`);
}
