import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { adminHref } from "@/components/admin/AdminSideskift";
import { hentStaffTal } from "@/lib/admin/taellere";
import { sidsteStaffBeskedOmHandel } from "@/lib/admin/paamindelse";
import { getStaffRole, harMindstRolle } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import AdminSearchInput from "@/components/admin/AdminSearchInput";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import HandelStatusBadge from "@/components/HandelStatusBadge";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminSide from "@/components/admin/AdminSide";
import AdminFaner, { type AdminFane } from "@/components/admin/AdminFaner";
import AdminFejl from "@/components/admin/AdminFejl";
import AdminTom from "@/components/admin/AdminTom";
import AdminBadge from "@/components/admin/AdminBadge";
import AdminListe, { type Kolonne } from "@/components/admin/AdminListe";
import HandelHandlinger, { AKTIVE, kr } from "@/components/admin/handler/HandelHandlinger";
import { UUID_RE, handelChatSti } from "@/lib/moderationLog";
import { SPORINGS_NAVN, erSporingsType } from "@/lib/fragt/types";
import {
  fragtAfslutHaengendeLabel,
  fragtGodkendEkstraLabel,
  fragtMarkerHaandteret,
} from "@/app/actions/adminFragt";
import { handelIkkeAfhentet } from "@/app/actions/adminIkkeAfhentet";
import { HAENGER_TEKST, erHaengerGrund, type HaengerGrund } from "@/lib/adminGraenser";

// Overblik over handler (flyttet fra /admin/sager, da sager fra køberen nu
// har deres egen side). Her kan staff markere en handel til opfølgning
// (trades.sag_aaben - fryser pengene), se handler der hænger, sende en
// fællesbesked og frigive/refundere manuelt. Sager fra køberen behandles
// under /admin/sager.

type HandelRow = {
  id: string;
  auction_id: string;
  seller_id: string;
  buyer_id: string;
  amount: number | string;
  status: string;
  tracking_number: string | null;
  created_at: string;
  sag_aaben: boolean;
  sag_note: string | null;
  sag_aabnet_at: string | null;
  afhentning: boolean | null;
};


// Forsendelser, staff skal se på (forsendelser.kraever_opmaerksomhed - samme
// tal som kortet "Fragt kræver handling" på admin-forsiden).
type FragtRow = {
  id: string;
  trade_id: string;
  type: "udgaaende" | "retur";
  status: string;
  sporingsnummer: string | null;
  opmaerksomhed_tekst: string | null;
  opdateret_kl: string;
};

const FORSENDELSE_STATUS: Record<string, string> = {
  opretter: "Labelen laves",
  annulleres: "Annulleres",
  annulleret: "Annulleret",
  fejlet: "Fejlet",
};

function forsendelseStatus(s: string) {
  return erSporingsType(s) ? SPORINGS_NAVN[s] : (FORSENDELSE_STATUS[s] ?? s);
}

// Hvilke handler der "hænger", afgøres af SQL-funktionen
// admin_haengende_handler() – den samme, som tæller kortene på admin-forsiden
// (grænserne står i src/lib/adminGraenser.ts).
type Haenger = { grund: HaengerGrund; siden: string };

const FANER = [
  { key: "sager", label: "Markeret af os" },
  { key: "haenger", label: "Hænger" },
  { key: "fragt", label: "Fragt" },
  { key: "aktive", label: "Aktive handler" },
  { key: "alle", label: "Alle" },
] as const;

// "Ikke afhentet" (ROADMAP-BESLUTNINGER afsnit 1, model 3).
const IKKE_AFHENTET_TITEL = "Pakken blev ikke afhentet?";
const IKKE_AFHENTET_TEKST =
  "Brug det, når fragtfirmaet har sendt pakken retur til sælgeren, fordi køberen ikke hentede den. Handlen annulleres. Køberen får købsbeløbet tilbage minus købergebyr, BidHamr Beskyttelse og fragten begge veje (returfragten = fragten ud) – aldrig under 0 kr. Sælgeren beholder varen, betaler ikke for fragten og får intet udbetalt. Begge får besked.";
const IKKE_AFHENTET_AARSAG = {
  label: "Begrundelse (intern)",
  placeholder: "Fx: DAO-sporing viser retur til afsender efter 7 dage i pakkeshoppen",
  required: true,
};

function dageSiden(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

async function HandlerIndhold({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; vis?: string }>;
}) {
  const rolle = await getStaffRole();
  if (!rolle) redirect("/");
  const kanFlyttePenge = harMindstRolle(rolle, "admin");
  // Fællesbesked til køber og sælger: kun admin og chef.
  const kanSkriveFaelles = harMindstRolle(rolle, "admin");

  const { q, vis: raaVis } = await searchParams;
  // "Markeret af os" hed før vis=sager (let at forveksle med Sager). Den gamle
  // adresse sendes videre, så links og bogmærker virker.
  if (raaVis === "sager") redirect(adminHref("/admin/handler", { vis: "markeret", q }));
  const vis = raaVis === "markeret" ? "sager" : raaVis;
  const fane = FANER.some((f) => f.key === vis) ? vis! : "haenger";
  const søgetekst = q?.trim() ?? "";
  const supabase = createAdminClient();
  const lavHref = (v: string) => adminHref("/admin/handler", { vis: v, q: søgetekst });

  const KOLONNER =
    "id, auction_id, seller_id, buyer_id, amount, status, tracking_number, created_at, sag_aaben, sag_note, sag_aabnet_at, afhentning";

  const [
    { data: handler },
    { data: haengende, error: haengerFejl },
    { data: fragtData, error: fragtFejl },
  ] = await Promise.all([
    supabase.from("trades").select(KOLONNER).order("created_at", { ascending: false }).limit(500),
    supabase.rpc("admin_haengende_handler"),
    supabase
      .from("forsendelser")
      .select("id, trade_id, type, status, sporingsnummer, opmaerksomhed_tekst, opdateret_kl")
      .eq("kraever_opmaerksomhed", true)
      .order("opdateret_kl", { ascending: true })
      .limit(200),
  ]);
  if (haengerFejl) console.error("admin_haengende_handler fejlede:", haengerFejl.message);
  if (fragtFejl) console.error("Forsendelser til staff kunne ikke hentes:", fragtFejl.message);
  const fragtRaekker = (fragtData ?? []) as FragtRow[];

  const haengerMap = new Map<string, Haenger>();
  for (const r of (haengende ?? []) as { trade_id: string; grund: unknown; siden: string }[]) {
    if (erHaengerGrund(r.grund)) haengerMap.set(r.trade_id, { grund: r.grund, siden: r.siden });
  }

  // Kun de 500 nyeste hentes. Ældre handler hentes med, når de hænger, eller
  // når der søges på et id (handel, auktion, køber eller sælger) – fx fra et
  // link i medarbejder-loggen.
  const nyeste = (handler ?? []) as HandelRow[];
  const kendte = new Set(nyeste.map((h) => h.id));
  const mangler = [...new Set([...haengerMap.keys(), ...fragtRaekker.map((f) => f.trade_id)])]
    .filter((id) => !kendte.has(id))
    .slice(0, 500);
  const søgUuid = UUID_RE.test(søgetekst) ? søgetekst.toLowerCase() : null;
  const [{ data: ekstra }, { data: idTraef }] = await Promise.all([
    mangler.length
      ? supabase.from("trades").select(KOLONNER).in("id", mangler)
      : Promise.resolve({ data: [] as HandelRow[] }),
    søgUuid
      ? supabase
          .from("trades")
          .select(KOLONNER)
          .or(`id.eq.${søgUuid},auction_id.eq.${søgUuid},buyer_id.eq.${søgUuid},seller_id.eq.${søgUuid}`)
          .order("created_at", { ascending: false })
          .limit(200)
      : Promise.resolve({ data: [] as HandelRow[] }),
  ]);
  const alle = [...nyeste];
  for (const h of [...((ekstra ?? []) as HandelRow[]), ...((idTraef ?? []) as HandelRow[])]) {
    if (!kendte.has(h.id)) {
      kendte.add(h.id);
      alle.push(h);
    }
  }
  alle.sort((x, y) => y.created_at.localeCompare(x.created_at));
  const haenger = (h: HandelRow) => haengerMap.has(h.id);

  const auktionIds = [...new Set(alle.map((h) => h.auction_id))];
  const brugerIds = [...new Set(alle.flatMap((h) => [h.buyer_id, h.seller_id]))];

  // "Ikke afhentet": handler (sendt, ikke afhentning), hvor fragtfirmaet har
  // meldt den udgående pakke retur uden at have leveret den. Kun dem får
  // medarbejdere knappen; uden returmelding kun admin/chef (databasen afgør
  // det også - 'kraever_admin').
  const sendteIds = alle.filter((h) => h.status === "pakke_sendt" && !h.afhentning).map((h) => h.id);
  // Hentes i bidder á 150 id'er (kort URL), så alle sendte handler på siden er med.
  const bidder: string[][] = [];
  for (let i = 0; i < sendteIds.length; i += 150) bidder.push(sendteIds.slice(i, i + 150));
  const [{ data: auktioner }, { data: brugere }, returMeldt] = await Promise.all([
    auktionIds.length
      ? supabase.from("auctions").select("id, titel").in("id", auktionIds)
      : Promise.resolve({ data: [] as { id: string; titel: string }[] }),
    brugerIds.length
      ? supabase.from("users").select("id, navn, email").in("id", brugerIds)
      : Promise.resolve({ data: [] as { id: string; navn: string | null; email: string }[] }),
    Promise.all(
      bidder.map((ids) =>
        supabase
          .from("forsendelser")
          .select("trade_id")
          .in("trade_id", ids)
          .eq("type", "udgaaende")
          .not("status", "in", "(annulleret,fejlet)")
          .not("returneret_kl", "is", null)
          .is("leveret_kl", null),
      ),
    ),
  ]);
  const returMeldtIds = new Set(returMeldt.flatMap((r) => (r.data ?? []).map((f) => f.trade_id as string)));

  const titelMap = new Map((auktioner ?? []).map((a) => [a.id, a.titel as string]));
  const brugerMap = new Map(
    (brugere ?? []).map((u) => [u.id, { navn: u.navn as string | null, email: u.email as string }]),
  );

  const antal = {
    sager: alle.filter((h) => h.sag_aaben).length,
    haenger: alle.filter(haenger).length,
    fragt: fragtRaekker.length,
    aktive: alle.filter((h) => AKTIVE.includes(h.status)).length,
    alle: alle.length,
  };

  let rows = alle.filter((h) => {
    if (fane === "sager") return h.sag_aaben;
    if (fane === "haenger") return haenger(h);
    if (fane === "fragt") return false;
    if (fane === "aktive") return AKTIVE.includes(h.status);
    return true;
  });

  if (søgetekst) {
    const nål = søgetekst.toLowerCase();
    rows = rows.filter((h) => {
      const k = brugerMap.get(h.buyer_id);
      const s = brugerMap.get(h.seller_id);
      return [
        titelMap.get(h.auction_id),
        k?.navn, k?.email, s?.navn, s?.email,
        h.tracking_number, h.sag_note, h.id, h.auction_id, h.buyer_id, h.seller_id,
      ].some((v) => (v ?? "").toLowerCase().includes(nål));
    });
  }

  const handelMap = new Map(alle.map((h) => [h.id, h]));
  const nålFragt = søgetekst.toLowerCase();
  const fragtVist = fragtRaekker.filter((f) => {
    if (!nålFragt) return true;
    const h = handelMap.get(f.trade_id);
    return [
      h ? titelMap.get(h.auction_id) : null,
      f.opmaerksomhed_tekst, f.sporingsnummer, f.trade_id, f.id,
    ].some((v) => (v ?? "").toLowerCase().includes(nålFragt));
  });
  const antalVist = fane === "fragt" ? fragtVist.length : rows.length;
  const enhed =
    fane === "fragt"
      ? antalVist === 1 ? "forsendelse" : "forsendelser"
      : antalVist === 1 ? "handel" : "handler";

  // "Påmindelse sendt for X t siden" på handler, der hænger.
  const paamindPar = rows
    .filter((h) => haengerMap.has(h.id))
    .map((h) => ({ tradeId: h.id, brugerId: haengerMap.get(h.id)!.grund === "ikke_sendt" ? h.seller_id : h.buyer_id }));
  const sidstPaamindet = (await sidsteStaffBeskedOmHandel(supabase, paamindPar)) ?? new Map<string, string>();
  const paamindKl = (h: HandelRow) => {
    const g = haengerMap.get(h.id);
    return g ? (sidstPaamindet.get(`${h.id}:${g.grund === "ikke_sendt" ? h.seller_id : h.buyer_id}`) ?? null) : null;
  };

  const faner: AdminFane[] = [
    { id: "haenger", label: "Hænger", href: lavHref("haenger"), antal: antal.haenger, tone: "gul" },
    { id: "fragt", label: "Fragt", href: lavHref("fragt"), antal: antal.fragt, tone: "gul" },
    { id: "sager", label: "Markeret af os", href: lavHref("markeret"), antal: antal.sager, tone: "graa" },
    { id: "ubetalte", label: "Ubetalte vindere", href: "/admin/ubetalte", antal: (await hentStaffTal()).ubetalte, tone: "graa" },
    { id: "aktive", label: "Aktive handler", href: lavHref("aktive") },
    { id: "alle", label: "Alle", href: lavHref("alle") },
  ];

  const personer = (h: HandelRow) => {
    const k = brugerMap.get(h.buyer_id);
    const s = brugerMap.get(h.seller_id);
    return (
      <span className="block space-y-0.5 text-[13px]">
        <span className="block min-w-0 truncate">
          <span className="text-tekst-svag">Køber </span>
          <Link href={`/admin/brugere/${h.buyer_id}`} className="text-tekst hover:underline">
            {k?.navn ?? "Uden navn"}
          </Link>
        </span>
        <span className="block min-w-0 truncate">
          <span className="text-tekst-svag">Sælger </span>
          <Link href={`/admin/brugere/${h.seller_id}`} className="text-tekst hover:underline">
            {s?.navn ?? "Uden navn"}
          </Link>
        </span>
      </span>
    );
  };

  const kolonner: Kolonne<HandelRow>[] = [
    {
      id: "status",
      label: "Status",
      mobil: "status",
      className: "lg:w-44",
      celle: (h) => {
        const forsinket = haengerMap.get(h.id);
        return (
          <span className="flex flex-wrap items-center gap-1.5 lg:block lg:space-y-1">
            <HandelStatusBadge status={h.status} />
            {h.sag_aaben && <AdminBadge tone="roed">Markeret</AdminBadge>}
            {forsinket && (
              <span className="block text-xs font-semibold text-advarsel-tekst">
                {HAENGER_TEKST[forsinket.grund]} · {dageSiden(forsinket.siden)} d
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: "auktion",
      label: "Handel",
      mobil: "titel",
      celle: (h) => (
        <span className="block min-w-0">
          <Link href={`/admin/handler/${h.id}`} className="font-semibold text-tekst hover:text-groen hover:underline">
            {titelMap.get(h.auction_id) ?? "(slettet auktion)"}
          </Link>
          <span className="block text-xs font-normal text-tekst-svag">
            {h.id.slice(0, 8)} · {dageSiden(h.created_at)} dage siden
            {h.tracking_number && <> · Sporing {h.tracking_number}</>}
          </span>
          {h.sag_aaben && h.sag_note && <span className="mt-0.5 block text-xs font-normal text-fejl-tekst">{h.sag_note}</span>}
        </span>
      ),
    },
    { id: "parter", label: "Køber / sælger", celle: personer, className: "lg:w-56" },
    { id: "beloeb", label: "Bud", hoejre: true, mobilLabel: true, className: "lg:w-24 whitespace-nowrap", celle: (h) => kr(h.amount) },
    {
      id: "handling",
      label: "Handlinger",
      mobil: "handling",
      className: "lg:w-[300px]",
      celle: (h) => (
        <HandelHandlinger
          h={h}
          titel={titelMap.get(h.auction_id) ?? "(slettet auktion)"}
          koeber={{ id: h.buyer_id, navn: brugerMap.get(h.buyer_id)?.navn ?? "Køber" }}
          saelger={{ id: h.seller_id, navn: brugerMap.get(h.seller_id)?.navn ?? "Sælger" }}
          haenger={haengerMap.get(h.id)?.grund ?? null}
          returMeldt={returMeldtIds.has(h.id)}
          kanFlyttePenge={kanFlyttePenge}
          kanSkriveFaelles={kanSkriveFaelles}
          sidstPaamindet={paamindKl(h)}
        />
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-tekst-daempet">
        {antalVist} {enhed}
      </p>

      <AdminFaner faner={faner} aktiv={fane} label="Handler" />

      {haengerFejl && <AdminFejl hvad="Handler, der hænger," />}
      {fragtFejl && fane === "fragt" && <AdminFejl hvad="Forsendelserne" />}

      <Suspense>
        <AdminSearchInput placeholder="Søg på auktion, køber, sælger, sporing, note eller id" />
      </Suspense>

      {fane === "fragt" && (
        <ul className="space-y-3">
          {fragtVist.map((f) => {
            const h = handelMap.get(f.trade_id);
            const handelSti = `/admin/handler/${encodeURIComponent(f.trade_id)}`;
            const lille =
              "inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-kant-staerk bg-white px-3 text-[13px] font-medium text-tekst transition-colors hover:bg-admin-bg lg:min-h-8";
            return (
              <li key={f.id} className="rounded-[14px] border border-advarsel-kant bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={handelSti} className="font-semibold text-tekst hover:text-groen hover:underline">
                      {h ? (titelMap.get(h.auction_id) ?? "(slettet auktion)") : "Handel"}
                    </Link>
                    <p className="mt-0.5 text-xs text-tekst-svag">
                      {f.type === "retur" ? "Returpakke" : "Pakke til køber"} · {forsendelseStatus(f.status)}
                      {f.sporingsnummer && (
                        <>
                          {" · Sporing: "}
                          <span className="break-all font-mono">{f.sporingsnummer}</span>
                        </>
                      )}
                    </p>
                  </div>
                  {h && <HandelStatusBadge status={h.status} />}
                </div>
                <p className="mt-3 break-words text-sm text-tekst">{f.opmaerksomhed_tekst ?? "Ingen forklaring."}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <ConfirmDialog
                    triggerLabel="Markér som håndteret"
                    triggerClassName="btn btn-primaer btn-lille"
                    title="Markér forsendelsen som håndteret?"
                    description="Markeringen fjernes. Ingen penge flyttes, og handlen ændres ikke."
                    confirmLabel="Markér som håndteret"
                    action={fragtMarkerHaandteret}
                    hiddenFields={{ forsendelseId: f.id }}
                    aarsagField={{
                      label: "Hvad har du gjort?",
                      placeholder: "Fx: ringede til sælgeren, der markerer pakken sendt i dag",
                      required: true,
                    }}
                    kvittering="Forsendelsen er markeret som håndteret"
                  />
                  <Link href={handelSti} className={lille}>
                    Åbn handel
                  </Link>
                  {/* prefetch slået fra: chatsiden logger læsningen. */}
                  <Link href={handelChatSti(f.trade_id)} prefetch={false} className={lille}>
                    Se chat
                  </Link>
                  {/* Hængende label (ukendt udfald hos Shipmondo): staff tjekker i Shipmondo først. */}
                  {f.status === "opretter" && (
                    <ConfirmDialog
                      triggerLabel="Afslut hængende label"
                      triggerClassName={lille}
                      title="Afslut den hængende fragtlabel"
                      description={`Tjek i Shipmondo, om der findes en forsendelse med referencen ${f.id}. Findes den: tilknyt den. Findes den ikke: markér labelen fejlet, så sælgeren kan prøve igen.`}
                      confirmLabel="Afslut label"
                      action={fragtAfslutHaengendeLabel}
                      hiddenFields={{ forsendelseId: f.id }}
                      valgField={{
                        name: "valg",
                        label: "Hvad fandt du i Shipmondo?",
                        valg: [
                          { value: "tilknyt", label: "Forsendelsen findes – tilknyt" },
                          { value: "fejlet", label: "Intet oprettet – markér fejlet" },
                        ],
                      }}
                      tekstFelter={[
                        {
                          name: "shipmondoId",
                          label: "Shipmondos forsendelses-id",
                          placeholder: "Kun tal, fx 123456789",
                          required: false,
                          maxLength: 20,
                          hjaelp: "Kræves ved tilknyt.",
                        },
                      ]}
                      valgKraeverTekst={{
                        valg: "tilknyt",
                        felt: "shipmondoId",
                        besked: "Skriv Shipmondos forsendelses-id.",
                      }}
                      aarsagField={{
                        label: "Hvad har du tjekket?",
                        placeholder: "Fx: søgte på referencen i Shipmondo – ingen forsendelse fundet",
                        required: true,
                      }}
                      kvittering="Den hængende label er afsluttet"
                    />
                  )}
                  {/* Pakken er meldt retur: staff registrerer "ikke afhentet" (når
                      fragtfirmaets signal ikke gør det automatisk). */}
                  {f.type === "udgaaende" && f.status === "returneret" && h && h.status === "pakke_sendt" && (
                    <ConfirmDialog
                      triggerLabel="Ikke afhentet"
                      triggerClassName={lille}
                      title={IKKE_AFHENTET_TITEL}
                      description={IKKE_AFHENTET_TEKST}
                      confirmLabel="Ja, pakken blev ikke afhentet"
                      action={handelIkkeAfhentet}
                      hiddenFields={{ tradeId: f.trade_id, forsendelseId: f.id }}
                      aarsagField={IKKE_AFHENTET_AARSAG}
                      fare
                      kanIkkeFortrydes
                      kvittering="Registreret som ikke afhentet"
                    />
                  )}
                  {f.type === "udgaaende" && (
                    <ConfirmDialog
                      triggerLabel="Godkend ekstra label"
                      triggerClassName={lille}
                      title="Godkend én ekstra fragtlabel?"
                      description="Sælgeren må højst lave 2 labels pr. handel. Hvert klik giver én label mere. Ingen penge flyttes, men BidHamr betaler den ekstra label hos fragtfirmaet."
                      confirmLabel="Godkend ekstra label"
                      action={fragtGodkendEkstraLabel}
                      hiddenFields={{ tradeId: f.trade_id }}
                      aarsagField={{
                        label: "Hvorfor må sælgeren lave en label mere?",
                        placeholder: "Fx: første label annulleret pga. forkert adresse, anden blev beskadiget",
                        required: true,
                      }}
                      kvittering="Ekstra label godkendt"
                    />
                  )}
                </div>
              </li>
            );
          })}
          {fragtVist.length === 0 && (
            <li>
              <AdminTom
                tekst={søgetekst ? `Ingen forsendelser matcher "${søgetekst}".` : "Ingen forsendelser kræver handling lige nu."}
                nulstilHref={søgetekst ? lavHref("fragt") : undefined}
              />
            </li>
          )}
        </ul>
      )}

      {fane !== "fragt" && (
        <AdminListe
          label="Handler"
          raekker={rows}
          kolonner={kolonner}
          noegle={(h) => h.id}
          fremhaev={(h) => h.sag_aaben || haengerMap.has(h.id)}
          tom={
            <AdminTom
              tekst={
                søgetekst
                  ? `Ingen handler matcher "${søgetekst}".`
                  : fane === "sager"
                    ? "Ingen handler er markeret af os."
                    : fane === "haenger"
                      ? "Ingen handler hænger lige nu."
                      : "Ingen handler endnu."
              }
              nulstilHref={søgetekst ? lavHref(fane === "sager" ? "markeret" : fane) : undefined}
            />
          }
        />
      )}
    </div>
  );
}

// Sidehovedet vises med det samme; listen (de tunge opslag) streames bagefter,
// så første visning ikke venter på databasen.
export default function AdminHandler(props: { searchParams: Promise<{ q?: string; vis?: string }> }) {
  return (
    <AdminSide>
      <AdminSideHoved
        titel="Handler"
        forklaring="Alle handler mellem køber og sælger. Brug siden, når en handel går i stå – fx hvis varen ikke er sendt."
        hjaelp={
          <p>
            Klager fra køberen behandles under{" "}
            <Link href="/admin/sager" className="font-medium text-groen hover:underline">
              Sager
            </Link>
            . Markerer du en handel her, fryses pengene, indtil markeringen fjernes. Hænger en handel, kan du sende en
            påmindelse direkte fra rækken.
          </p>
        }
      />
      <Suspense fallback={<HandlerSkelet />}>
        <HandlerIndhold {...props} />
      </Suspense>
    </AdminSide>
  );
}

function HandlerSkelet() {
  return (
    <div aria-busy="true" aria-label="Indlæser handler" className="space-y-4">
      <div className="h-11 animate-pulse rounded-lg bg-skelet/60" />
      <div className="h-11 animate-pulse rounded-lg bg-skelet/50" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-24 animate-pulse rounded-[14px] bg-skelet/40" />
      ))}
    </div>
  );
}
