import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function AuktionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: auktion } = await supabase
    .from("auctions")
    .select("*")
    .eq("id", id)
    .single();

  if (!auktion) {
    notFound();
  }

  return (
    <main className="flex flex-1 justify-center bg-white px-4 py-10">
      <div className="w-full max-w-2xl">
        {auktion.billeder?.[0] && (
          <img
            src={auktion.billeder[0]}
            alt={auktion.titel}
            className="aspect-video w-full object-cover"
          />
        )}

        {auktion.billeder?.length > 1 && (
          <div className="mt-2 grid grid-cols-5 gap-2">
            {auktion.billeder.slice(1).map((url: string) => (
              <img
                key={url}
                src={url}
                alt={auktion.titel}
                className="aspect-square w-full object-cover"
              />
            ))}
          </div>
        )}

        <h1 className="mt-6 text-2xl font-semibold text-neutral-900">
          {auktion.titel}
        </h1>

        <p className="mt-1 text-sm text-neutral-500">
          {auktion.kategori} · {auktion.postnummer}
        </p>

        {auktion.beskrivelse && (
          <p className="mt-4 text-sm text-neutral-700">
            {auktion.beskrivelse}
          </p>
        )}

        <div className="mt-6 flex items-center justify-between border-t border-neutral-200 pt-4">
          <div>
            <p className="text-xs text-neutral-500">Nuværende bud</p>
            <p className="text-xl font-bold text-neutral-900">
              {(auktion.nuværende_bud ?? auktion.startpris).toLocaleString(
                "da-DK",
              )}{" "}
              kr
            </p>
          </div>

          <p className="text-sm text-neutral-500">
            Slutter{" "}
            {new Date(auktion.slutter_kl).toLocaleString("da-DK", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        </div>

        {auktion.forsendelse_mulig && (
          <p className="mt-2 text-xs text-neutral-500">
            Sælger tilbyder forsendelse mod betaling.
          </p>
        )}
      </div>
    </main>
  );
}
