import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { BidPanelBud } from "@/components/BidPanel";
import AuctionGallery from "@/components/AuctionGallery";
import AuctionTitleActions from "@/components/AuctionTitleActions";
import BidPanel from "@/components/BidPanel";
import Accordion from "@/components/Accordion";
import RatingForm from "@/components/RatingForm";
import AnmeldOpslagKnap from "@/components/AnmeldOpslagKnap";
import StartChatKnap from "@/components/StartChatKnap";
import { kortNavn } from "@/lib/kortNavn";

const MAKS_BUD_HENTET = 50;

export default async function AuktionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: auktion }, { data: authData }] = await Promise.all([
    supabase.from("auctions").select("*").eq("id", id).single(),
    supabase.auth.getUser(),
  ]);

  if (!auktion || auktion.skjult) {
    notFound();
  }

  // Bud kan ikke laeses af andre end byderen selv (bydernes privatliv). Siden
  // henter dem med service-role, men kun til serverens egne beregninger
  // (vinder) og en anonymiseret budhistorik - bruger-id'er og navne sendes
  // aldrig til browseren.
  const { data: budRaw } = await createAdminClient()
    .from("bids")
    .select("id, bruger_id, beløb, oprettet")
    .eq("auktion_id", id)
    .order("oprettet", { ascending: false })
    .limit(MAKS_BUD_HENTET)
    .overrideTypes<
      { id: string; bruger_id: string; beløb: number; oprettet: string }[],
      { merge: false }
    >();
  const bud = budRaw ?? [];

  const { data: saelger } = await supabase
    .from("users")
    .select("navn")
    .eq("id", auktion.bruger_id)
    .maybeSingle();
  const sælgerNavn = kortNavn(saelger?.navn ?? null);

  // "Byder 1", "Byder 2" ... i den raekkefoelge, de foerst bød. Egne bud vises som "Dig".
  const byderNr = new Map<string, number>();
  for (const b of [...bud].reverse()) {
    if (!byderNr.has(b.bruger_id)) byderNr.set(b.bruger_id, byderNr.size + 1);
  }
  const mitId = authData.user?.id ?? null;
  const anonymeBud: BidPanelBud[] = bud.map((b) => ({
    id: b.id,
    beløb: Number(b.beløb),
    oprettet: b.oprettet,
    erMig: b.bruger_id === mitId,
    byder: b.bruger_id === mitId ? "Dig" : `Byder ${byderNr.get(b.bruger_id)}`,
  }));

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
  // Vinderen vises anonymt som i budhistorikken ("Dig" / "Byder 2") - aldrig
  // navn eller bruger-id (bydernes privatliv).
  const vinderId: string | null =
    (auktion.vinder_id as string | null | undefined) ??
    (auktion.status !== "aktiv" ? (vinderBud?.bruger_id ?? null) : null);
  const vinderVisning =
    vinderId && auktion.status !== "aktiv"
      ? vinderId === mitId
        ? "Dig"
        : byderNr.has(vinderId)
          ? `Byder ${byderNr.get(vinderId)}`
          : null
      : null;
  const bruger = authData.user ?? null;
  const erVinder = Boolean(
    auktionErSlut && vinderBud && bruger?.id === vinderBud.bruger_id,
  );
  const erSælger = bruger?.id === auktion.bruger_id;

  // Handelstilstand: e-money-afregningen opretter en handel ved auktionsluk.
  // Betalingen er dermed allerede sket - der er intet "betal nu"-trin.
  let handel: {
    id: string;
    status: string;
    buyer_id: string;
    seller_id: string;
  } | null = null;
  if (auktionErSlut && vinderBud && (erVinder || erSælger)) {
    const { data } = await supabase
      .from("trades")
      .select("id, status, buyer_id, seller_id")
      .eq("auction_id", id)
      .maybeSingle();
    handel = data;
  }

  // Kun køberen i handlen må bedømme, og kun sælgeren. Sælgeren bedømmer
  // ikke køberen (ROADMAP-BESLUTNINGER.md afsnit 6). Sandheden om hvem der
  // handlede er trades-rækken – ikke budlisten – så formularen vises kun, når
  // der findes en handel, hvor brugeren er køber.
  const maaBedømme = Boolean(
    bruger && handel && handel.buyer_id === bruger.id && handel.seller_id === auktion.bruger_id,
  );

  const handelGodkendt =
    handel?.status === "leveret" || handel?.status === "afsluttet";

  let harBedømt = false;
  if (maaBedømme && bruger) {
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
            {erVinder && (
              <div className="mb-4 border border-brand bg-red-50 p-4">
                <p className="font-semibold text-brand">
                  🎉 Du har vundet denne auktion!
                </p>
                <p className="mt-1 text-sm text-neutral-700">
                  Betal inden for 24 timer under handlen. Aftal det
                  praktiske med sælgeren i handelschatten.
                </p>
                {/* Knappen vises altid; findes handlen endnu ikke, venter
                    komponenten på at pg_cron opretter den. */}
                <StartChatKnap
                  auktionId={auktion.id}
                  tradeId={handel?.id ?? null}
                />
              </div>
            )}

            {erSælger && auktionErSlut && vinderBud && (
              <div className="mb-4 border border-brand bg-red-50 p-4">
                <p className="font-semibold text-brand">
                  Din auktion er solgt
                </p>
                <p className="mt-1 text-sm text-neutral-700">
                  Køberen har 24 timer til at betale. Du får pengene udbetalt,
                  når køberen har godkendt varen. Aftal levering med
                  køberen i handelschatten.
                </p>
                <StartChatKnap
                  auktionId={auktion.id}
                  tradeId={handel?.id ?? null}
                />
              </div>
            )}

            <div className="lg:sticky lg:top-4">
              <BidPanel
                auktionId={auktion.id}
                initialNuværendeBud={Number(
                  auktion.nuværende_bud ?? auktion.startpris,
                )}
                initialSlutterKl={auktion.slutter_kl}
                initialBud={anonymeBud}
                brugerId={authData.user?.id ?? null}
                saelgerId={auktion.bruger_id}
                forsendelseMulig={auktion.forsendelse_mulig}
                status={auktion.status}
                vinderVisning={vinderVisning}
              />
            </div>

            {/* Rating-sektion – kun køberen i handlen kan bedømme sælgeren */}
            {maaBedømme && !handelGodkendt && (
              <p className="mt-4 text-sm text-neutral-600">
                Du kan bedømme sælgeren, når du har godkendt varen.
              </p>
            )}

            {maaBedømme && handelGodkendt && !harBedømt && (
              <div className="mt-4">
                <RatingForm
                  auktionId={auktion.id}
                  tilBrugerId={auktion.bruger_id}
                  rolle="sælger"
                />
              </div>
            )}

            {maaBedømme && harBedømt && (
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
                  ? "Sælger sender varen. Fragt koster 35 kr og lægges oven i din betaling."
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
