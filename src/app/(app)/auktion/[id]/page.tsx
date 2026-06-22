import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AuctionGallery from "@/components/AuctionGallery";
import AuctionTitleActions from "@/components/AuctionTitleActions";
import BidPanel from "@/components/BidPanel";
import Accordion from "@/components/Accordion";
import { anonymUsername } from "@/lib/anonymUsername";

const MAKS_BUD_HENTET = 50;

export default async function AuktionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: auktion }, { data: bud }, { data: authData }] =
    await Promise.all([
      supabase.from("auctions").select("*").eq("id", id).single(),
      supabase
        .from("bids")
        .select("*")
        .eq("auktion_id", id)
        .order("oprettet", { ascending: false })
        .limit(MAKS_BUD_HENTET),
      supabase.auth.getUser(),
    ]);

  if (!auktion) {
    notFound();
  }

  const varenummer = auktion.id.slice(-6).toUpperCase();
  const auktionErSlut = new Date(auktion.slutter_kl) <= new Date();
  const vinderBud = bud?.[0] ?? null;
  const erVinder = Boolean(
    auktionErSlut && vinderBud && authData.user?.id === vinderBud.bruger_id,
  );

  return (
    <main className="flex-1 bg-white px-4 py-6 sm:px-8">
      <div className="mx-auto max-w-6xl">
        {/* Zone 1 – top */}
        <div className="flex items-center justify-between gap-3">
          <nav className="text-xs text-neutral-500">
            <Link href="/auktioner" className="hover:text-brand">
              Alle auktioner
            </Link>
            {" > "}
            <span>{auktion.kategori}</span>
            {" > "}
            <span className="text-neutral-700">{auktion.titel}</span>
          </nav>

          <span className="bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-500">
            Varenr. {varenummer}
          </span>
        </div>

        {/* Zone 2 – midten */}
        <div className="mt-4 grid grid-cols-1 gap-8 lg:grid-cols-5">
          {/* Venstre kolonne (60%) */}
          <div className="lg:col-span-3">
            <AuctionGallery
              billeder={auktion.billeder ?? []}
              titel={auktion.titel}
            />

            <div className="mt-4 flex items-start justify-between gap-3">
              <h1 className="text-2xl font-bold text-brand sm:text-3xl">
                {auktion.titel}
              </h1>
              <AuctionTitleActions />
            </div>

            <div className="my-4 border-t border-neutral-200" />

            <h2 className="text-sm font-semibold text-[#111]">Oversigt</h2>
            <dl className="mt-3 grid grid-cols-2 gap-y-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-neutral-500">Lokation</dt>
                <dd className="text-[#111]">
                  {auktion.lokation
                    ? `${auktion.lokation} (${auktion.postnummer})`
                    : auktion.postnummer}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-500">Kategori</dt>
                <dd className="text-[#111]">{auktion.kategori}</dd>
              </div>
              <div>
                <dt className="text-neutral-500">Sælger</dt>
                <dd className="text-[#111]">
                  {anonymUsername(auktion.bruger_id)}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-500">Forsendelse</dt>
                <dd className="text-[#111]">
                  {auktion.forsendelse_mulig ? "Tilbydes" : "Ikke tilbudt"}
                </dd>
              </div>
            </dl>

            {auktion.beskrivelse && (
              <>
                <div className="my-4 border-t border-neutral-200" />
                <h2 className="text-sm font-semibold text-[#111]">
                  Beskrivelse
                </h2>
                <p className="mt-2 text-sm text-neutral-700">
                  {auktion.beskrivelse}
                </p>
              </>
            )}
          </div>

          {/* Højre kolonne (40%) */}
          <div className="lg:col-span-2">
            {erVinder && (
              <div className="mb-4 border border-brand bg-red-50 p-4">
                <p className="font-semibold text-brand">
                  🎉 Du har vundet denne auktion!
                </p>
                <Link
                  href={`/auktion/${auktion.id}/betal`}
                  className="mt-3 inline-block rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38]"
                >
                  Gå til betaling
                </Link>
              </div>
            )}

            <div className="lg:sticky lg:top-4">
              <BidPanel
                auktionId={auktion.id}
                initialNuværendeBud={Number(
                  auktion.nuværende_bud ?? auktion.startpris,
                )}
                initialSlutterKl={auktion.slutter_kl}
                initialBud={bud ?? []}
                brugerId={authData.user?.id ?? null}
                forsendelseMulig={auktion.forsendelse_mulig}
              />
            </div>

            <div className="mt-4 space-y-2">
              <Accordion title="Sådan fungerer afhentning">
                Varen kan afhentes i{" "}
                {auktion.lokation
                  ? `${auktion.lokation} (postnr. ${auktion.postnummer})`
                  : `postnr. ${auktion.postnummer}`}
                . Kontakt sælger efter vundet auktion for at aftale tid og
                sted.
              </Accordion>

              <Accordion title="Forsendelse">
                {auktion.forsendelse_mulig
                  ? "Sælger tilbyder forsendelse mod betaling. Pris aftales med sælger efter vundet auktion."
                  : "Ikke tilbudt – varen skal afhentes."}
              </Accordion>

              <Accordion title="Sikker handel med Hamr">
                Hamr opbevarer betalingen sikkert, indtil du har modtaget og
                godkendt varen, så både køber og sælger er beskyttet under
                handlen.
              </Accordion>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
