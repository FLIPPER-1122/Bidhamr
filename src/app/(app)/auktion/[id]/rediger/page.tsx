import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import RedigerAuktionForm from "@/components/RedigerAuktionForm";

// Sælgeren redigerer sin auktion, så længe der ikke er bud. Databasen
// (rediger_auktion) håndhæver det samme og låser auktionen under ændringen.
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
    <main className="flex flex-1 justify-center bg-white px-4 py-10">
      <div className="w-full max-w-2xl">
        <Link href={`/auktion/${id}`} className="text-sm text-neutral-500 hover:text-groen">
          ← Tilbage til auktionen
        </Link>
        <h1 className="mt-3 font-serif text-[26px] font-semibold text-tekst sm:text-[32px]">Redigér auktion</h1>

        <div className="mt-6">
          {erSlut ? (
            <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
              Auktionen er ikke aktiv længere og kan ikke ændres.
            </p>
          ) : harBud ? (
            <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
              Der er budt på auktionen, så den kan ikke længere ændres.
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
              }}
            />
          )}
        </div>
      </div>
    </main>
  );
}
