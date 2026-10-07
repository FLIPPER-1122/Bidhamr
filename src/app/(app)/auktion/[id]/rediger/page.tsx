import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import RedigerAuktionForm from "@/components/RedigerAuktionForm";
import { AuktionLaastTekst } from "@/components/SaelgerAuktionHandlinger";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Redigér auktion",
  robots: { index: false, follow: false },
};

// Sælgeren redigerer sin auktion, så længe der ikke er bud. Efter første bud
// vises formularen ikke - kun en besked om, at auktionen er låst. Databasen
// (rediger_auktion, auctions_beskyt_kolonner) håndhæver det samme og låser
// auktionen under ændringen.
export default async function RedigerAuktionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login");

  // "*": supabase-js kan ikke parse "nuværende_bud" i en select-streng.
  const { data: auktion } = await supabase.from("auctions").select("*").eq("id", id).maybeSingle();

  if (!auktion || auktion.skjult || auktion.bruger_id !== authData.user.id) notFound();

  // Sælgeren kan ikke læse andres bud, men auktion_har_bud svarer ja/nej.
  const { data: harBudData } = await supabase.rpc("auktion_har_bud", { p_auktion_id: id });
  const harBud = auktion.nuværende_bud != null || harBudData === true;
  const erSlut = auktion.status !== "aktiv" || new Date(auktion.slutter_kl) <= new Date();

  return (
    <main className="flex flex-1 justify-center px-4 py-8 sm:px-6 lg:py-10">
      <div className="w-full max-w-2xl">
        <Link href={`/auktion/${id}`} className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-tekst-daempet hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen">
          ← Tilbage til auktionen
        </Link>
        <h1 className="mt-1 text-[26px] leading-tight sm:text-[32px]">Redigér auktion</h1>

        <div className="mt-6">
          {erSlut ? (
            <p className="rounded-lg border border-kant bg-groen-lys px-4 py-3 text-sm text-tekst-daempet">
              Auktionen er ikke aktiv længere og kan ikke ændres.
            </p>
          ) : harBud ? (
            <p className="rounded-lg border border-kant bg-groen-lys px-4 py-3 text-sm text-tekst-daempet">
              <AuktionLaastTekst />
            </p>
          ) : (
            <RedigerAuktionForm
              auktionId={auktion.id}
              brugerId={authData.user.id}
              start={{
                titel: auktion.titel ?? "",
                beskrivelse: auktion.beskrivelse ?? "",
                billeder: auktion.billeder ?? [],
                kategori: auktion.kategori ?? "",
                startpris: Number(auktion.startpris),
                forsendelseMulig: Boolean(auktion.forsendelse_mulig),
                stand: (auktion.stand as string | null | undefined) ?? null,
                producent: (auktion.producent as string | null | undefined) ?? null,
                sikkerhedsoplysninger: (auktion.sikkerhedsoplysninger as string | null | undefined) ?? null,
              }}
              erFirma={auktion.erhverv === true}
            />
          )}
        </div>
      </div>
    </main>
  );
}
