import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { kortNavn } from "@/lib/kortNavn";
import KontoSideHoved from "@/components/konto/KontoSideHoved";
import FulgteSaelgere, { type FulgtSaelger } from "@/components/foelg/FulgteSaelgere";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sælgere du følger", robots: { index: false, follow: false } };

export default async function FoelgerSide() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login?redirect=/konto/foelger");

  // mine_fulgte_saelgere() udleder brugeren af auth.uid().
  const { data, error } = await supabase.rpc("mine_fulgte_saelgere");
  if (error) console.error("Fulgte sælgere kunne ikke hentes:", error.message);
  const saelgere: FulgtSaelger[] = (
    (data ?? []) as {
      saelger_id: string;
      navn: string | null;
      avatar_url: string | null;
      aktive_auktioner: number;
    }[]
  ).map((s) => ({
    id: s.saelger_id,
    navn: kortNavn(s.navn),
    avatarUrl: s.avatar_url,
    aktiveAuktioner: s.aktive_auktioner,
  }));

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <KontoSideHoved
        titel="Sælgere du følger"
        krumme="Følger"
        tekst="Du får besked, når en sælger, du følger, sætter en ny vare til salg. Sælgeren kan ikke se, at du følger dem."
      />
      {error ? (
        <p role="alert" className="mt-6 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Listen kunne ikke hentes lige nu. Prøv igen om lidt.
        </p>
      ) : (
        <FulgteSaelgere start={saelgere} />
      )}
    </main>
  );
}
