import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import KontaktForm from "@/components/tryghed/KontaktForm";
import { erKontaktEmne } from "@/lib/tryghed";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Kontakt kundeservice",
  description: "Skriv til BidHamrs kundeservice om handler, betaling eller fejl på siden.",
};

export default async function KontaktSide({
  searchParams,
}: {
  searchParams: Promise<{ emne?: string; handel?: string }>;
}) {
  const { emne, handel } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // E-mail forudfyldes for indloggede (kolonnen kan kun læses via min_profil).
  let email = "";
  if (user) {
    const { data } = await supabase.rpc("min_profil").maybeSingle<{ email: string }>();
    email = data?.email ?? user.email ?? "";
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:py-12">
      <h1 className="font-serif text-[26px] leading-tight font-semibold text-tekst sm:text-[32px]">
        Kontakt os
      </h1>
      <p className="mt-2 text-base text-tekst-daempet">
        Har du spørgsmål eller er der noget, der driller? Skriv til os, så hjælper vi dig.
      </p>

      <div className="mt-6 rounded-2xl border border-kant bg-white p-5 sm:p-6">
        <KontaktForm
          email={email}
          emne={erKontaktEmne(emne) ? emne : "generelt"}
          handel={(handel ?? "").slice(0, 100)}
        />
      </div>

      <p className="mt-6 text-sm text-tekst-svag">
        Du kan også skrive til{" "}
        <a href="mailto:support@bidhamr.dk" className="font-medium text-groen hover:underline">
          support@bidhamr.dk
        </a>
        .
      </p>
    </main>
  );
}
