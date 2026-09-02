import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AuctionGallery from "@/components/AuctionGallery";
import AuctionTitleActions from "@/components/AuctionTitleActions";
import BidPanel from "@/components/BidPanel";
import Accordion from "@/components/Accordion";
import RatingForm from "@/components/RatingForm";
import BekræftModtagelseKnap from "@/components/BekræftModtagelseKnap";
import AnmeldOpslagKnap from "@/components/AnmeldOpslagKnap";
import { kortNavn } from "@/lib/kortNavn";

const MAKS_BUD_HENTET = 50;

export default async function AuktionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: auktion }, { data: budRaw }, { data: authData }] =
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

  if (!auktion || auktion.skjult) {
    notFound();
  }

  // Hent navne til sælger og alle budgivere i ét opkald
  const budBrugerIds = [...new Set((budRaw ?? []).map((b) => b.bruger_id))];
  const alleIds = [...new Set([auktion.bruger_id, ...budBrugerIds])];
  const { data: brugerNavne } = await supabase
    .from("users")
    .select("id, navn")
    .in("id", alleIds);
  const navnMap = Object.fromEntries(
    (brugerNavne ?? []).map((u) => [u.id, u.navn as string | null]),
  );

  const bud = (budRaw ?? []).map((b) => ({ ...b, navn: navnMap[b.bruger_id] ?? null }));
  const sælgerNavn = kortNavn(navnMap[auktion.bruger_id]);

  const varenummer = auktion.id.slice(-6).toUpperCase();
  const auktionErSlut = new Date(auktion.slutter_kl) <= new Date();
  // Vinderen er det højeste bud (ikke det seneste) – samme logik som
  // betal-siden og checkout-API'et.
  const vinderBud =
    (bud ?? []).reduce<(typeof bud)[number] | null>(
      (bedste, b) =>
        !bedste || Number(b.beløb) > Number(bedste.beløb) ? b : bedste,
      null,
    ) ?? null;
  const bruger = authData.user ?? null;
  const erVinder = Boolean(
    auktionErSlut && vinderBud && bruger?.id === vinderBud.bruger_id,
  );
  const erSælger = bruger?.id === auktion.bruger_id;
  const erKøber = Boolean(vinderBud && bruger?.id === vinderBud.bruger_id);

  // Escrow-tilstand: findes der en betalt/frigivet transaktion for auktionen?
  let transaktion: {
    status: string;
    udbetaling_beløb: number | null;
  } | null = null;
  if (auktionErSlut && vinderBud && (erVinder || erSælger)) {
    const { data } = await supabase
      .from("transactions")
      .select("status, udbetaling_beløb")
      .eq("auktion_id", id)
      .in("status", ["betalt", "frigivet"])
      .maybeSingle()
      .overrideTypes<
        { status: string; udbetaling_beløb: number | null },
        { merge: false }
      >();
    transaktion = data;
  }

  // Brugeren kan bedømme hvis: auktion er slut, der er en vinder, og brugeren
  // er enten køber eller sælger (de kan ikke være begge, da man ikke kan byde på egne auktioner)
  const erInvolveret = auktionErSlut && !!vinderBud && !!bruger && (erKøber || erSælger);

  let harBedømt = false;
  if (erInvolveret && bruger) {
    const { data: eksisterendeRating } = await supabase
      .from("ratings")
      .select("id")
      .eq("fra_bruger_id", bruger.id)
      .eq("auktion_id", id)
      .maybeSingle();
    harBedømt = !!eksisterendeRating;
  }

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
                <dd>
                  <Link
                    href={`/profil/${auktion.bruger_id}`}
                    className="font-medium text-brand hover:underline"
                  >
                    {sælgerNavn}
                  </Link>
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

            {/* Sælgeren har ingen grund til at anmelde sit eget opslag */}
            {!erSælger && (
              <>
                <div className="my-4 border-t border-neutral-200" />
                <AnmeldOpslagKnap
                  auktionId={auktion.id}
                  brugerId={bruger?.id ?? null}
                />
              </>
            )}
          </div>

          {/* Højre kolonne (40%) */}
          <div className="lg:col-span-2">
            {erVinder && !transaktion && (
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

            {erVinder && transaktion?.status === "betalt" && (
              <div className="mb-4 border border-brand bg-red-50 p-4">
                <p className="font-semibold text-brand">
                  Betaling gennemført
                </p>
                <p className="mt-1 text-sm text-neutral-700">
                  Beløbet opbevares sikkert af BidHamr. Tryk på knappen, når du
                  har modtaget varen – så frigives pengene til sælgeren.
                </p>
                <div className="mt-3">
                  <BekræftModtagelseKnap auktionId={auktion.id} />
                </div>
              </div>
            )}

            {erVinder && transaktion?.status === "frigivet" && (
              <div className="mb-4 border border-green-300 bg-green-50 p-4">
                <p className="font-semibold text-green-700">
                  Handel afsluttet
                </p>
                <p className="mt-1 text-sm text-green-700">
                  Du har bekræftet modtagelsen, og beløbet er frigivet til
                  sælgeren. God fornøjelse med varen!
                </p>
              </div>
            )}

            {erSælger && transaktion?.status === "betalt" && (
              <div className="mb-4 border border-brand bg-red-50 p-4">
                <p className="font-semibold text-brand">
                  Din auktion er vundet – afvent købers bekræftelse
                </p>
                <p className="mt-1 text-sm text-neutral-700">
                  Køberen har betalt, og beløbet står i sikker forvaring hos
                  BidHamr. Pengene frigives til dig, når køberen har bekræftet
                  modtagelsen.
                </p>
              </div>
            )}

            {erSælger && transaktion?.status === "frigivet" && (
              <div className="mb-4 border border-green-300 bg-green-50 p-4">
                <p className="font-semibold text-green-700">
                  Handel afsluttet
                </p>
                <p className="mt-1 text-sm text-green-700">
                  Køberen har bekræftet modtagelsen.
                  {transaktion.udbetaling_beløb != null &&
                    ` ${Number(transaktion.udbetaling_beløb).toLocaleString("da-DK")} kr udbetales til dig (fratrukket 10% sælgergebyr).`}
                </p>
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
                saelgerId={auktion.bruger_id}
                forsendelseMulig={auktion.forsendelse_mulig}
              />
            </div>

            {/* Rating-sektion – vises når auktion er slut og bruger er involveret */}
            {erInvolveret && !harBedømt && bruger && vinderBud && (
              <div className="mt-4">
                <RatingForm
                  auktionId={auktion.id}
                  tilBrugerId={erKøber ? auktion.bruger_id : vinderBud.bruger_id}
                  rolle={erKøber ? "sælger" : "køber"}
                />
              </div>
            )}

            {erInvolveret && harBedømt && (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
                <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Du har allerede afgivet en bedømmelse for denne handel.
              </div>
            )}

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

              <Accordion title="Sikker handel med BidHamr">
                BidHamr opbevarer betalingen sikkert, indtil du har modtaget og
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
