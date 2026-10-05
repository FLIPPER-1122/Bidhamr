import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import FoelgKnap from "@/components/foelg/FoelgKnap";
import type { BidPanelBud } from "@/components/BidPanel";
import AuctionGallery from "@/components/AuctionGallery";
import AuctionTitleActions from "@/components/AuctionTitleActions";
import BidPanel from "@/components/BidPanel";
import Accordion from "@/components/Accordion";
import AnmeldOpslagKnap from "@/components/AnmeldOpslagKnap";
import StartChatKnap from "@/components/StartChatKnap";
import SaelgerAuktionHandlinger from "@/components/SaelgerAuktionHandlinger";
import SpoergSaelger from "@/components/SpoergSaelger";
import SpaerByder, { type ByderValg } from "@/components/tryghed/SpaerByder";
import { kortNavn } from "@/lib/kortNavn";
import { standNavn } from "@/lib/stand";
import { getStaffRole } from "@/lib/adminAuth";
import type { SpoergsmaalVisning } from "@/lib/spoergsmaal";
import { auktionMetadata } from "@/lib/auktionSeo";

// Titel, beskrivelse (pris + slut), første billede som delebillede og
// canonical. JSON-LD ligger i layout.tsx.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return auktionMetadata(id);
}

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

  // Spørg sælger: offentlig liste uden bruger-id'er (auktion_spoergsmaal_liste).
  // Fejler kaldet (fx før migrationen er kørt), vises bare ingen spørgsmål.
  // Er der en blokering/spærring mellem sælgeren og den indloggede (begge
  // retninger)? er_blokeret_mellem er intern (kun service-role) og kaldes
  // kun med den indloggede brugers eget id. Browseren får kun true/false –
  // aldrig om det er en anonym byder-spærring eller en navngiven blokering.
  const tjekBlokering =
    mitId && mitId !== auktion.bruger_id
      ? createAdminClient()
          .rpc("er_blokeret_mellem", { p_a: auktion.bruger_id, p_b: mitId })
          .then(({ data, error }) => (error ? false : data === true))
      : Promise.resolve(false);
  const [{ data: spoergsmaalData }, staffRolle, blokeretMedSaelger, { data: minFoelgning }] = await Promise.all([
    supabase.rpc("auktion_spoergsmaal_liste", { p_auktion: id }),
    authData.user ? getStaffRole() : Promise.resolve(null),
    tjekBlokering,
    // Følger jeg sælgeren? RLS: kun egne følgninger kan læses.
    mitId && mitId !== auktion.bruger_id
      ? supabase.from("seller_follows").select("id").eq("seller_id", auktion.bruger_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const spoergsmaal = (Array.isArray(spoergsmaalData) ? spoergsmaalData : []) as SpoergsmaalVisning[];

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
  // auctions.vinder_id er sandheden: den flyttes til næste byder, hvis
  // vinderen ikke betalte, og byderen sagde ja til at købe varen.
  const erVinder = Boolean(auktionErSlut && vinderBud && bruger && bruger.id === vinderId);
  const erSælger = bruger?.id === auktion.bruger_id;
  // Redigér/annullér: kun på en igangværende auktion (låst efter første bud).
  const harBud = auktion.nuværende_bud != null || bud.length > 0;
  const kanStyreAuktion = erSælger && auktion.status === "aktiv" && !auktionErSlut;
  // Sælgeren kan spærre en byder ud fra et af byderens bud (kun bud-id og
  // "Byder N" sendes til browseren - aldrig bruger-id eller navn).
  const spaerbareBydere: ByderValg[] = kanStyreAuktion
    ? [...byderNr.entries()]
        .filter(([brugerId]) => brugerId !== mitId)
        .map(([brugerId, nr]) => ({
          budId: bud.find((b) => b.bruger_id === brugerId)!.id,
          byder: `Byder ${nr}`,
        }))
    : [];

  // Handelstilstand: cron-jobbet opretter handel + betaling ved auktionsluk.
  // Betalingen er dermed allerede sket - der er intet "betal nu"-trin.
  let handel: {
    id: string;
    status: string;
    buyer_id: string;
    seller_id: string;
  } | null = null;
  if (auktionErSlut && vinderBud && (erVinder || erSælger)) {
    // En auktion kan have flere handler, hvis vinderen ikke betalte og varen
    // gik videre til næste byder (kun én er ikke-annulleret). Den nyeste er
    // den gældende; RLS viser kun handler, brugeren selv er part i.
    const { data } = await supabase
      .from("trades")
      .select("id, status, buyer_id, seller_id")
      .eq("auction_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    handel = data;
  }

  // Kun køberen i handlen bedømmer, og kun sælgeren (ROADMAP-BESLUTNINGER.md
  // afsnit 6). Bedømmelsen afgives samtidig med godkendelsen af varen under
  // Mine handler - her vises kun en kvittering, når den er afgivet.
  const maaBedømme = Boolean(
    bruger && handel && handel.buyer_id === bruger.id && handel.seller_id === auktion.bruger_id,
  );

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

  const sektionsLinje = "my-6 border-t border-kant";
  const sektionsTitel = "text-[17px] leading-snug lg:text-lg";

  return (
    <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 pt-4 pb-8 sm:px-6 lg:px-8 lg:pt-6 lg:pb-10">
      {/* Zone 1 – top */}
      <div className="flex items-center justify-between gap-3">
        <nav aria-label="Brødkrumme" className="min-w-0 text-[13px] text-tekst-svag">
          <ol className="flex min-w-0 items-center gap-1.5">
            <li className="shrink-0">
              <Link
                href="/auktioner"
                className="inline-flex min-h-11 items-center rounded-md hover:text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
              >
                Alle auktioner
              </Link>
            </li>
            <li aria-hidden="true" className="shrink-0">›</li>
            <li className="min-w-0 shrink">
              <Link
                href={`/auktioner?kategori=${encodeURIComponent(auktion.kategori ?? "")}`}
                className="inline-flex min-h-11 max-w-full items-center truncate rounded-md hover:text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
              >
                <span className="truncate">{auktion.kategori}</span>
              </Link>
            </li>
            <li aria-hidden="true" className="hidden shrink-0 sm:block">›</li>
            <li className="hidden min-w-0 truncate text-tekst-daempet sm:block" aria-current="page">
              {auktion.titel}
            </li>
          </ol>
        </nav>

        <span className="shrink-0 rounded-full bg-groen-lys px-3 py-1 text-xs font-medium text-groen-mork">
          Varenr. {varenummer}
        </span>
      </div>

      {/* Zone 2 – midten. På mobil: billeder og titel, så pris og bud, og
          først derefter detaljer, beskrivelse og Spørg sælger. På store
          skærme ligger budboksen i højre spalte ved siden af det hele. */}
      <div className="mt-2 grid grid-cols-1 gap-x-10 gap-y-6 lg:mt-4 lg:grid-cols-5 lg:grid-rows-[auto_1fr]">
        {/* Billeder og titel */}
        <div className="min-w-0 lg:col-span-3 lg:row-start-1">
          <AuctionGallery
            billeder={auktion.billeder ?? []}
            titel={auktion.titel}
          />

          <div className="mt-4 flex items-start justify-between gap-3">
            <h1 className="min-w-0 text-[26px] leading-tight break-words sm:text-[32px]">
              {auktion.titel}
            </h1>
            <AuctionTitleActions auktionId={auktion.id} titel={auktion.titel} />
          </div>
        </div>

        {/* Højre spalte: status, bud og praktisk info */}
        <div className="min-w-0 lg:col-span-2 lg:col-start-4 lg:row-span-2 lg:row-start-1">
          {erVinder && (
            <div className="mb-4 rounded-[14px] border border-succes-kant bg-succes-bg p-4">
              <p className="font-semibold text-succes-tekst">
                Du har vundet denne auktion!
              </p>
              <p className="mt-1 text-sm text-tekst-daempet">
                Betal inden for 48 timer under handlen. Aftal det
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
            <div className="mb-4 rounded-[14px] border border-succes-kant bg-succes-bg p-4">
              <p className="font-semibold text-succes-tekst">
                Din auktion er solgt
              </p>
              <p className="mt-1 text-sm text-tekst-daempet">
                {auktion.forsendelse_mulig
                  ? "Køberen har 48 timer til at betale. Du får pengene udbetalt, når køberen har godkendt varen. Aftal levering med køberen i handelschatten."
                  : "Køberen har 48 timer til at betale. Aftal tid og sted for afhentning i handelschatten. Du får pengene udbetalt, når køberen har hentet varen, og du har tastet køberens afhentningskode ind."}
              </p>
              <StartChatKnap
                auktionId={auktion.id}
                tradeId={handel?.id ?? null}
              />
            </div>
          )}

          {kanStyreAuktion && (
            <SaelgerAuktionHandlinger auktionId={auktion.id} harBud={harBud} />
          )}
          {spaerbareBydere.length > 0 && <SpaerByder bydere={spaerbareBydere} />}

          <div className="lg:sticky lg:top-4">
            <BidPanel
              auktionId={auktion.id}
              initialNuværendeBud={Number(
                auktion.nuværende_bud ?? auktion.startpris,
              )}
              startpris={Number(auktion.startpris)}
              initialHarBud={auktion.nuværende_bud != null}
              redigeretKl={(auktion.redigeret_kl as string | null | undefined) ?? null}
              initialSlutterKl={auktion.slutter_kl}
              initialBud={anonymeBud}
              brugerId={authData.user?.id ?? null}
              saelgerId={auktion.bruger_id}
              forsendelseMulig={auktion.forsendelse_mulig}
              status={auktion.status}
              vinderVisning={vinderVisning}
            />

            {/* Kvittering for bedømmelsen – den afgives ved godkendelse af varen */}
            {maaBedømme && harBedømt && (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-succes-kant bg-succes-bg px-4 py-3 text-sm text-succes-tekst">
                <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Du har bedømt sælgeren for denne handel.
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
                {auktion.forsendelse_mulig
                  ? "Betalingen håndteres af vores betalingspartner Stripe. Sælgeren får først pengene, når du har modtaget og godkendt varen."
                  : "Betalingen håndteres af vores betalingspartner Stripe. Sælgeren får først pengene, når du har hentet varen og vist din afhentningskode. Vis først koden, når du har set varen og er tilfreds."}
              </Accordion>
            </div>
          </div>
        </div>

        {/* Detaljer, beskrivelse og Spørg sælger */}
        <div className="min-w-0 lg:col-span-3 lg:col-start-1 lg:row-start-2">
          <div className="border-t border-kant pt-6 lg:border-t-0 lg:pt-0">
            <h2 className={sektionsTitel}>Oversigt</h2>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
              <div className="min-w-0">
                <dt className="text-tekst-svag">Lokation</dt>
                <dd className="break-words text-tekst">
                  {auktion.lokation
                    ? `${auktion.lokation} (${auktion.postnummer})`
                    : auktion.postnummer}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-tekst-svag">Kategori</dt>
                <dd className="text-tekst">{auktion.kategori}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-tekst-svag">Sælger</dt>
                <dd>
                  <Link
                    href={`/profil/${auktion.bruger_id}`}
                    className="inline-flex min-h-11 items-center rounded-md font-medium break-words text-groen hover:underline sm:min-h-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
                  >
                    {sælgerNavn}
                  </Link>
                  {mitId !== auktion.bruger_id && !blokeretMedSaelger && (
                    <div className="mt-1.5">
                      <FoelgKnap
                        saelgerId={auktion.bruger_id}
                        navn={sælgerNavn}
                        foelger={Boolean(minFoelgning)}
                        loginHref={mitId ? undefined : `/login?redirect=/auktion/${auktion.id}`}
                        lille
                      />
                    </div>
                  )}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-tekst-svag">Stand</dt>
                <dd className="text-tekst">{standNavn(auktion.stand as string | null | undefined)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-tekst-svag">Forsendelse</dt>
                <dd className="text-tekst">
                  {auktion.forsendelse_mulig ? "Tilbydes" : "Ikke tilbudt"}
                </dd>
              </div>
            </dl>
          </div>

          {auktion.beskrivelse && (
            <>
              <div className={sektionsLinje} />
              <h2 className={sektionsTitel}>Beskrivelse</h2>
              <p className="mt-2 max-w-[65ch] text-[15px] leading-relaxed break-words whitespace-pre-line text-tekst">
                {auktion.beskrivelse}
              </p>
            </>
          )}

          <div className={sektionsLinje} />
          <SpoergSaelger
            auktionId={auktion.id}
            spoergsmaal={spoergsmaal}
            aktiv={(auktion.spoergsmaal_aktiv as boolean | null | undefined) !== false}
            auktionKoerer={auktion.status === "aktiv" && !auktionErSlut}
            erSaelger={erSælger}
            erStaff={!!staffRolle}
            loggetInd={!!bruger}
            kanIkkeSpoerge={blokeretMedSaelger}
          />

          {/* Sælgeren har ingen grund til at anmelde sit eget opslag */}
          {!erSælger && (
            <>
              <div className={sektionsLinje} />
              <AnmeldOpslagKnap
                auktionId={auktion.id}
                brugerId={bruger?.id ?? null}
              />
            </>
          )}
        </div>
      </div>

      {/* Fast budbjælke i bunden på mobil (BidPanel lægger indholdet her) */}
      <div id="byd-bjaelke" className="sticky bottom-0 z-20 -mx-4 sm:-mx-6 lg:hidden" />
    </main>
  );
}
