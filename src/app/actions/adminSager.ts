"use server";

// Staff: behandling af sager fra køberen (ROADMAP-BESLUTNINGER afsnit 4 og
// "Sager (Filip, 3. oktober 2026)").
//
// Roller:
//   medarbejder+  se sager, afgøre, registrere retur, åbne sagschat
//   admin+        genåbne en afgjort/lukket sag, lukke en konto permanent
//   chef          ser beløb (refusion, total) - alle andre ser aldrig beløb
//
// Pengeflow (databasen afgør og claimer atomisk; Stripe kaldes bagefter).
// ANKEFRIST: pengene flyttes først 4 dage efter afgørelsen
// (sager.penge_flyttes_efter_kl). Indtil da er pengene frosset, og admin kan
// genåbne sagen, hvilket annullerer den planlagte flytning. Cron
// (afviklForfaldneSager i src/lib/sagerServer.ts) flytter pengene:
//   medhold køber, svindel/bortkommet      -> refusion efter fristen
//       (alt undtagen BidHamr Beskyttelse) -> refunderBetaling (delvis refusion)
//   medhold køber, skadet/ikke som beskrevet -> 'afventer_retur'; refusion når
//       BÅDE "Retur afleveret" er registreret OG fristen er udløbet
//   medhold sælger -> frigivelse efter fristen -> overfoerTilSaelger
//   luk sag        -> frysningen fjernes efter fristen; handlen fortsætter
// Fejler Stripe-kaldet, er refusionen stadig claimet; cron prøver igen
// (refunderSagerVentende), og betalingen markeres til admin.
// Aldrig dobbelt refusion (refusion_anmodet_kl + idempotency key), aldrig
// refusion efter overførsel (samme rækkelås som betaling_claim_overfoersel),
// og en åben indsigelse afviser både refusion og frigivelse.
//
// Fejl RETURNERES som { fejl } (Next skjuler kastede fejl i produktion).
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { assertRole, harMindstRolle, type StaffRole } from "@/lib/adminAuth";
import {
  hentBetalingForHandel,
  indsigelseBlokerer,
  refunderBetaling,
} from "@/lib/betaling/stripeBetaling";
import { aabnChat } from "@/app/actions/staffChat";
import { notificerSagAfgoerelse, sagFristTekst, type SagUdfaldBesked } from "@/lib/sagerServer";
import { hentPakkeBilleder, type VistPakkeBillede } from "@/lib/pakkebillederServer";
import {
  SAG_BEGRUNDELSE_MAKS,
  SAG_PENGE_FEJL_NAVN,
  type SagPengeHandling,
  SAG_BUCKET,
  SAG_CHAT_TYPE,
  SAG_STATUSSER,
  SAG_TYPE_NAVN,
  type SagBilledeKategori,
  type SagStatus,
  type SagType,
  adminSagSti,
  erSagType,
  sagSti,
} from "@/lib/sager";

// Hvem må afgøre en sag (inkl. de pengehandlinger, afgørelsen udløser)?
// Databasen (sag_afgoer/sag_retur_afleveret) kræver mindst medarbejder.
const AFGOER_ROLLE: StaffRole = "medarbejder";

class BrugerFejl extends Error {}

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const INGEN_ADGANG = "Du har ikke adgang til at gøre dette.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function erUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

async function koer<T>(navn: string, fn: () => Promise<T>): Promise<T | { fejl: string }> {
  try {
    return await fn();
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: INGEN_ADGANG };
    }
    console.error(`Sager: ${navn} fejlede:`, err);
    return { fejl: GENERISK };
  }
}

function tekst(formData: FormData, navn: string): string {
  const v = formData.get(navn);
  return typeof v === "string" ? v.trim() : "";
}

const KODE_FEJL: Record<string, string> = {
  ingen_adgang: INGEN_ADGANG,
  ugyldigt_udfald: "Vælg et udfald.",
  begrundelse_mangler: "Skriv en begrundelse til køber og sælger. Den vises for dem begge.",
  for_lang_tekst: "Teksten er for lang.",
  ikke_fundet: "Sagen findes ikke.",
  forkert_status: "Sagen er allerede afgjort eller har ændret status. Genindlæs siden.",
  indsigelse:
    "Køberen har en åben indsigelse hos sin bank. Pengene kan ikke flyttes, før indsigelsen er afgjort.",
  ikke_mulig:
    "Pengene kan ikke refunderes: betalingen er ikke betalt, allerede refunderet eller overført til sælger.",
  penge_flyttet: "Sagen kan ikke genåbnes, fordi pengene allerede er refunderet eller udbetalt.",
  findes: "Der er allerede en anden åben sag på handlen.",
  aarsag_mangler: "Skriv en årsag.",
  ugyldig_bruger: "Brugeren findes ikke.",
  sig_selv: "Du kan ikke lukke din egen konto.",
  staff: "Medarbejdere, admins og chefer kan ikke lukkes herfra.",
  allerede_lukket: "Kontoen er allerede lukket permanent.",
  ugyldig_sag: "Brugeren er ikke part i sagen.",
  inhabil: "Du kan ikke behandle en sag, hvor du selv er køber eller sælger.",
};

function kodeFejl(kode: string | undefined): string {
  return KODE_FEJL[kode ?? ""] ?? GENERISK;
}

type RpcSvar = {
  kode: string;
  handling?: string;
  betaling_id?: string | null;
  trade_id?: string;
  buyer_id?: string;
  seller_id?: string;
  auction_id?: string;
  type?: string;
  // sager.genaabnet_antal efter handlingen (nøgle for beskeder).
  version?: number;
  // Ankefrist: hvornår pengene tidligst flyttes.
  penge_flyttes_efter_kl?: string | null;
  // Medhold til sælger: frigivelsen er blokeret lige nu (fx indsigelse).
  advarsel?: string | null;
  // Retur afleveret efter fristen, men refusionen er blokeret.
  grund?: string | null;
  annulleret_planlagt?: boolean | null;
};

function revalider(sagId: string, tradeId?: string) {
  revalidatePath("/admin", "layout");
  revalidatePath("/admin/sager");
  revalidatePath(adminSagSti(sagId));
  if (tradeId) revalidatePath(sagSti(tradeId));
  revalidatePath("/mine-handler");
}

async function version(admin: Awaited<ReturnType<typeof assertRole>>["admin"], sagId: string) {
  const { data } = await admin
    .from("sager")
    .select("genaabnet_antal")
    .eq("id", sagId)
    .maybeSingle<{ genaabnet_antal: number }>();
  return Number(data?.genaabnet_antal ?? 0);
}

// ------------------------------------------------------------------ Typer

export type SagListeRaekke = {
  id: string;
  tradeId: string;
  type: SagType;
  status: SagStatus;
  beskyttelse: boolean;
  oprettetKl: string;
  afgjortKl: string | null;
  auktionTitel: string | null;
  auktionId: string | null;
  koeber: { id: string; navn: string | null };
  saelger: { id: string; navn: string | null };
  antalBilleder: number;
};

export type SagDetalje = SagListeRaekke & {
  beskrivelse: string;
  begrundelse: string | null;
  internNote: string | null;
  afgjortAfNavn: string | null;
  returKraeves: boolean;
  returfragtBetaler: "koeber" | "bidhamr" | null;
  returAfleveretKl: string | null;
  genaabnetAntal: number;
  genaabnetKl: string | null;
  // Ankefrist: hvad der sker med pengene, hvornår, og om det er sket.
  pengeHandling: SagPengeHandling | null;
  pengeFlyttesEfterKl: string | null;
  afvikletKl: string | null;
  // Hvorfor pengene ikke kunne flyttes efter fristen (dansk tekst), ellers null.
  pengeFejl: string | null;
  // Sagen er oprettet før "modtaget" (bortkommet / aldrig sendt): tjek sporingen.
  tjekSporing: boolean;
  handelStatus: string;
  handelStatusVedOprettelse: string;
  trackingNumber: string | null;
  sendtKl: string | null;
  modtagetKl: string | null;
  billeder: { id: string; kategori: SagBilledeKategori; url: string | null; oprettetKl: string }[];
  // Sælgerens billeder af indpakningen fra "Send pakke".
  pakkebilleder: VistPakkeBillede[];
  betaling: {
    status: string;
    beskyttelse: boolean;
    frigivet: boolean;
    overfoert: boolean;
    refusionAnmodet: boolean;
    refunderet: boolean;
    indsigelse: boolean;
    kraeverOpmaerksomhed: boolean;
    // Kun for chef - ellers null.
    totalOere: number | null;
    beskyttelseOere: number | null;
    refusionOere: number | null;
  } | null;
  // Konti (til "Luk konto permanent").
  koeberLukket: boolean;
  saelgerLukket: boolean;
  // Hvad den aktuelle medarbejder må.
  kan: {
    afgoere: boolean;
    registrereRetur: boolean;
    genaabne: boolean;
    lukkeKonto: boolean;
    seBeloeb: boolean;
  };
  log: { handling: string; aarsag: string; oprettetKl: string; medarbejderNavn: string | null }[];
};

type SagDbRaekke = {
  id: string;
  trade_id: string;
  oprettet_af: string;
  type: string;
  beskrivelse: string;
  status: SagStatus;
  beskyttelse: boolean;
  handel_status_ved_oprettelse: string;
  oprettet_kl: string;
  afgjort_af: string | null;
  afgjort_kl: string | null;
  begrundelse: string | null;
  intern_note: string | null;
  retur_kraeves: boolean;
  returfragt_betaler: "koeber" | "bidhamr" | null;
  retur_afleveret_kl: string | null;
  refusion_oere: number | null;
  genaabnet_antal: number;
  genaabnet_kl: string | null;
  penge_handling: SagPengeHandling | null;
  penge_flyttes_efter_kl: string | null;
  afviklet_kl: string | null;
  penge_fejl: string | null;
  tjek_sporing: boolean;
};

const LISTE_KOLONNER = "id, trade_id, type, status, beskyttelse, oprettet_kl, afgjort_kl";

// ------------------------------------------------------------------ Læs

// Liste til Sager-siden. filter: 'aabne' (aaben + afventer_retur), 'afgjorte'
// (afgjort/lukket) eller en enkelt status. Uden beløb.
export async function hentSager(
  filter: "aabne" | "afgjorte" | SagStatus = "aabne",
  side = 0,
): Promise<{ sager: SagListeRaekke[]; flere: boolean } | { fejl: string }> {
  return koer("hentSager", async () => {
    const { admin } = await assertRole("medarbejder");
    const STR = 50;
    const s = Number.isInteger(side) && side >= 0 ? side : 0;
    let q = admin
      .from("sager")
      .select(LISTE_KOLONNER)
      .order("oprettet_kl", { ascending: filter === "aabne" })
      .range(s * STR, s * STR + STR);
    if (filter === "aabne") q = q.in("status", ["aaben", "afventer_retur"]);
    else if (filter === "afgjorte") q = q.in("status", ["afgjort_koeber", "afgjort_saelger", "lukket"]);
    else if ((SAG_STATUSSER as readonly string[]).includes(filter)) q = q.eq("status", filter);
    else throw new BrugerFejl("Ukendt filter.");
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const raekker = (data ?? []) as {
      id: string;
      trade_id: string;
      type: string;
      status: SagStatus;
      beskyttelse: boolean;
      oprettet_kl: string;
      afgjort_kl: string | null;
    }[];
    const flere = raekker.length > STR;
    const sider = raekker.slice(0, STR);
    return { sager: await berig(admin, sider), flere };
  });
}

async function berig(
  admin: Awaited<ReturnType<typeof assertRole>>["admin"],
  raekker: {
    id: string;
    trade_id: string;
    type: string;
    status: SagStatus;
    beskyttelse: boolean;
    oprettet_kl: string;
    afgjort_kl: string | null;
  }[],
): Promise<SagListeRaekke[]> {
  if (raekker.length === 0) return [];
  const tradeIds = [...new Set(raekker.map((r) => r.trade_id))];
  const { data: handler } = await admin
    .from("trades")
    .select("id, auction_id, buyer_id, seller_id")
    .in("id", tradeIds);
  const hMap = new Map(
    ((handler ?? []) as { id: string; auction_id: string; buyer_id: string; seller_id: string }[]).map(
      (h) => [h.id, h],
    ),
  );
  const auktionIds = [...new Set([...hMap.values()].map((h) => h.auction_id))];
  const brugerIds = [...new Set([...hMap.values()].flatMap((h) => [h.buyer_id, h.seller_id]))];
  const [{ data: auktioner }, { data: brugere }, { data: billeder }] = await Promise.all([
    auktionIds.length
      ? admin.from("auctions").select("id, titel").in("id", auktionIds)
      : Promise.resolve({ data: [] }),
    brugerIds.length
      ? admin.from("users").select("id, navn").in("id", brugerIds)
      : Promise.resolve({ data: [] }),
    admin.from("sag_billeder").select("sag_id").in("sag_id", raekker.map((r) => r.id)),
  ]);
  const titel = new Map(((auktioner ?? []) as { id: string; titel: string }[]).map((a) => [a.id, a.titel]));
  const navn = new Map(((brugere ?? []) as { id: string; navn: string | null }[]).map((u) => [u.id, u.navn]));
  const antal = new Map<string, number>();
  for (const b of (billeder ?? []) as { sag_id: string }[]) antal.set(b.sag_id, (antal.get(b.sag_id) ?? 0) + 1);

  return raekker
    .filter((r) => erSagType(r.type))
    .map((r) => {
      const h = hMap.get(r.trade_id);
      return {
        id: r.id,
        tradeId: r.trade_id,
        type: r.type as SagType,
        status: r.status,
        beskyttelse: r.beskyttelse,
        oprettetKl: r.oprettet_kl,
        afgjortKl: r.afgjort_kl,
        auktionTitel: h ? (titel.get(h.auction_id) ?? null) : null,
        auktionId: h?.auction_id ?? null,
        koeber: { id: h?.buyer_id ?? "", navn: h ? (navn.get(h.buyer_id) ?? null) : null },
        saelger: { id: h?.seller_id ?? "", navn: h ? (navn.get(h.seller_id) ?? null) : null },
        antalBilleder: antal.get(r.id) ?? 0,
      };
    });
}

// Én sag med alt, staff skal bruge for at afgøre den. Beløb kun for chef.
// Samtaler med køber/sælger hentes med hentSamtalerForSag(SAG_CHAT_TYPE, sagId)
// fra src/app/actions/staffChat.ts.
export async function hentSag(sagId: string): Promise<{ sag: SagDetalje } | { fejl: string }> {
  return koer("hentSag", async () => {
    const { admin, rolle } = await assertRole("medarbejder");
    if (!erUuid(sagId)) throw new BrugerFejl("Sagen findes ikke.");
    const { data: s, error } = await admin
      .from("sager")
      .select(
        "id, trade_id, oprettet_af, type, beskrivelse, status, beskyttelse, handel_status_ved_oprettelse, oprettet_kl, afgjort_af, afgjort_kl, begrundelse, intern_note, retur_kraeves, returfragt_betaler, retur_afleveret_kl, refusion_oere, genaabnet_antal, genaabnet_kl, penge_handling, penge_flyttes_efter_kl, afviklet_kl, penge_fejl, tjek_sporing",
      )
      .eq("id", sagId)
      .maybeSingle<SagDbRaekke>();
    if (error) throw new Error(error.message);
    if (!s || !erSagType(s.type)) throw new BrugerFejl("Sagen findes ikke.");

    const [liste] = await berig(admin, [s]);
    const seBeloeb = harMindstRolle(rolle, "chef");

    const [{ data: t }, betaling, { data: billeder }, { data: log }, pakkebilleder] = await Promise.all([
      admin
        .from("trades")
        .select("status, tracking_number, sendt_kl, received_at")
        .eq("id", s.trade_id)
        .single<{ status: string; tracking_number: string | null; sendt_kl: string | null; received_at: string | null }>(),
      hentBetalingForHandel(s.trade_id),
      admin
        .from("sag_billeder")
        .select("id, sti, kategori, oprettet_kl")
        .eq("sag_id", s.id)
        .order("oprettet_kl", { ascending: true }),
      admin
        .from("moderation_log")
        .select("medarbejder_id, handling, aarsag, oprettet_kl")
        .eq("maal_type", "sag")
        .eq("maal_id", s.id)
        .order("oprettet_kl", { ascending: true })
        .limit(100),
      hentPakkeBilleder(admin, s.trade_id),
    ]);

    const billedRaekker = (billeder ?? []) as {
      id: string;
      sti: string;
      kategori: SagBilledeKategori;
      oprettet_kl: string;
    }[];
    const urls = new Map<string, string>();
    if (billedRaekker.length > 0) {
      const { data: signerede } = await admin.storage
        .from(SAG_BUCKET)
        .createSignedUrls(billedRaekker.map((b) => b.sti), 3600);
      for (const x of signerede ?? []) if (x.path && x.signedUrl) urls.set(x.path, x.signedUrl);
    }

    const logRaekker = (log ?? []) as {
      medarbejder_id: string;
      handling: string;
      aarsag: string;
      oprettet_kl: string;
    }[];
    const staffIds = [
      ...new Set([...logRaekker.map((l) => l.medarbejder_id), ...(s.afgjort_af ? [s.afgjort_af] : [])]),
    ];
    const [{ data: staffNavne }, { data: konti }] = await Promise.all([
      staffIds.length
        ? admin.from("users").select("id, navn").in("id", staffIds)
        : Promise.resolve({ data: [] }),
      admin
        .from("users")
        .select("id, konto_lukket_kl")
        .in("id", [liste.koeber.id, liste.saelger.id].filter(Boolean)),
    ]);
    const staffNavn = new Map(
      ((staffNavne ?? []) as { id: string; navn: string | null }[]).map((u) => [u.id, u.navn]),
    );
    const lukket = new Map(
      ((konti ?? []) as { id: string; konto_lukket_kl: string | null }[]).map((u) => [u.id, !!u.konto_lukket_kl]),
    );

    const aaben = s.status === "aaben" || s.status === "afventer_retur";
    const kanAfgoere = harMindstRolle(rolle, AFGOER_ROLLE);

    return {
      sag: {
        ...liste,
        beskrivelse: s.beskrivelse,
        begrundelse: s.begrundelse,
        internNote: s.intern_note,
        afgjortAfNavn: s.afgjort_af ? (staffNavn.get(s.afgjort_af) ?? null) : null,
        returKraeves: s.retur_kraeves,
        returfragtBetaler: s.returfragt_betaler,
        returAfleveretKl: s.retur_afleveret_kl,
        genaabnetAntal: s.genaabnet_antal,
        genaabnetKl: s.genaabnet_kl,
        pengeHandling: s.penge_handling,
        pengeFlyttesEfterKl: s.penge_flyttes_efter_kl,
        afvikletKl: s.afviklet_kl,
        pengeFejl: s.penge_fejl ? (SAG_PENGE_FEJL_NAVN[s.penge_fejl] ?? s.penge_fejl) : null,
        tjekSporing: s.tjek_sporing,
        handelStatus: t?.status ?? "",
        handelStatusVedOprettelse: s.handel_status_ved_oprettelse,
        trackingNumber: t?.tracking_number ?? null,
        sendtKl: t?.sendt_kl ?? null,
        modtagetKl: t?.received_at ?? null,
        billeder: billedRaekker.map((b) => ({
          id: b.id,
          kategori: b.kategori,
          url: urls.get(b.sti) ?? null,
          oprettetKl: b.oprettet_kl,
        })),
        pakkebilleder,
        betaling: betaling
          ? {
              status: betaling.status,
              beskyttelse: betaling.beskyttelse,
              frigivet: !!betaling.frigivet_kl,
              overfoert: !!betaling.stripe_transfer_id || !!betaling.overfoersel_paabegyndt_kl,
              refusionAnmodet: !!betaling.refusion_anmodet_kl,
              refunderet: betaling.status === "refunderet",
              indsigelse: indsigelseBlokerer(betaling),
              kraeverOpmaerksomhed: betaling.kraever_opmaerksomhed,
              totalOere: seBeloeb ? Number(betaling.total_oere) : null,
              beskyttelseOere: seBeloeb ? Number(betaling.beskyttelse_oere) : null,
              refusionOere: seBeloeb && s.refusion_oere !== null ? Number(s.refusion_oere) : null,
            }
          : null,
        koeberLukket: lukket.get(liste.koeber.id) ?? false,
        saelgerLukket: lukket.get(liste.saelger.id) ?? false,
        kan: {
          afgoere: kanAfgoere && aaben,
          registrereRetur: kanAfgoere && s.status === "afventer_retur",
          // Databasen (sag_genaabn) afviser, hvis pengene allerede er flyttet.
          // Inden for ankefristen annulleres den planlagte flytning.
          genaabne:
            harMindstRolle(rolle, "admin") &&
            s.status !== "aaben" &&
            !(s.penge_handling === "refunder" && s.afviklet_kl) &&
            !(betaling && (betaling.refusion_anmodet_kl || betaling.stripe_transfer_id || betaling.overfoersel_paabegyndt_kl)),
          lukkeKonto: harMindstRolle(rolle, "admin"),
          seBeloeb,
        },
        log: logRaekker.map((l) => ({
          handling: l.handling,
          aarsag: l.aarsag,
          oprettetKl: l.oprettet_kl,
          medarbejderNavn: staffNavn.get(l.medarbejder_id) ?? null,
        })),
      },
    };
  });
}

// Badge i admin-menuen: sager, der venter på en afgørelse.
export async function hentAntalAabneSager() {
  return koer("hentAntalAabneSager", async () => {
    const { admin } = await assertRole("medarbejder");
    const { count, error } = await admin
      .from("sager")
      .select("id", { count: "exact", head: true })
      .eq("status", "aaben");
    if (error) throw new Error(error.message);
    return { ok: true as const, antal: count ?? 0 };
  });
}

// ------------------------------------------------------------------ Afgør

type Udfald = { ok: true; besked: string };

function fristTekst(svar: RpcSvar): string {
  return svar.penge_flyttes_efter_kl ? sagFristTekst(svar.penge_flyttes_efter_kl) : "om 4 dage";
}

function fejlNavn(kode: string | null | undefined): string {
  return SAG_PENGE_FEJL_NAVN[kode ?? ""] ?? "betalingen er ikke klar";
}

// Kører Stripe-delen, når en refusion er claimet med det samme (retur
// afleveret efter ankefristen). Kaster aldrig - pengene er claimet i
// databasen, og cron prøver igen.
async function refunderNu(betalingId: string): Promise<string> {
  try {
    const r = await refunderBetaling(betalingId);
    return r === "refunderet" || r === "allerede_refunderet"
      ? "Køberen er refunderet (alt undtagen BidHamr Beskyttelse)."
      : "Refusionen er sendt til Stripe og afventer bekræftelse.";
  } catch (err) {
    console.error("Sagsrefusion fejlede (cron prøver igen):", betalingId, err);
    return "Refusionen fejlede hos Stripe. Den prøves igen automatisk, og betalingen er markeret til admin.";
  }
}

// Kort besked til staff efter en afgørelse (uden beløb). Ingen penge flyttes
// ved afgørelsen - kun efter ankefristen.
function afgoerelsesBesked(svar: RpcSvar): string {
  const frist = fristTekst(svar);
  switch (svar.handling) {
    case "planlagt_refusion":
      return `Køberen refunderes (alt undtagen BidHamr Beskyttelse) tidligst ${frist}, når ankefristen er udløbet. Admin kan genåbne sagen indtil da.`;
    case "afvent_retur":
      return `Køberen skal sende varen retur. Registrér, når returpakken er afleveret. Køberen refunderes, når returpakken er afleveret og ankefristen er udløbet (tidligst ${frist}).`;
    case "planlagt_frigivelse":
      return svar.advarsel
        ? `Sagen er afgjort. Pengene frigives til sælgeren tidligst ${frist}, men lige nu er frigivelsen blokeret: ${fejlNavn(svar.advarsel)}. Følg op under Betalinger.`
        : `Sagen er afgjort. Pengene frigives til sælgeren tidligst ${frist}, når ankefristen er udløbet. Admin kan genåbne sagen indtil da.`;
    default:
      return `Sagen er lukket uden at flytte penge. Frysningen fjernes ${frist}, og derefter fortsætter handlen normalt.`;
  }
}

const AFGOER_BESKED: Record<string, SagUdfaldBesked> = {
  planlagt_refusion: "planlagt_refusion",
  afvent_retur: "afvent_retur",
  planlagt_frigivelse: "planlagt_frigivelse",
  lukket: "lukket",
};

// formData: sagId, udfald ('koeber' | 'saelger' | 'lukket'),
// begrundelse (til køber og sælger, påkrævet), intern_note (valgfri).
export async function afgoerSag(formData: FormData): Promise<Udfald | { fejl: string }> {
  return koer("afgoerSag", async () => {
    const { admin, userId } = await assertRole(AFGOER_ROLLE);
    const sagId = tekst(formData, "sagId");
    const udfald = tekst(formData, "udfald");
    const begrundelse = tekst(formData, "begrundelse");
    const internNote = tekst(formData, "intern_note");
    if (!erUuid(sagId)) throw new BrugerFejl("Sagen findes ikke.");
    if (!["koeber", "saelger", "lukket"].includes(udfald)) throw new BrugerFejl(KODE_FEJL.ugyldigt_udfald);
    if (!begrundelse) throw new BrugerFejl(KODE_FEJL.begrundelse_mangler);
    if (begrundelse.length > SAG_BEGRUNDELSE_MAKS || internNote.length > 4000) {
      throw new BrugerFejl(KODE_FEJL.for_lang_tekst);
    }

    const { data, error } = await admin.rpc("sag_afgoer", {
      p_medarbejder: userId,
      p_sag: sagId,
      p_udfald: udfald,
      p_begrundelse: begrundelse,
      p_intern_note: internNote || null,
    });
    if (error) throw new Error(error.message);
    const svar = (data ?? { kode: "" }) as RpcSvar;
    if (svar.kode !== "ok") throw new BrugerFejl(kodeFejl(svar.kode));

    const besked = afgoerelsesBesked(svar);

    const type = svar.type;
    const beskedType = AFGOER_BESKED[svar.handling ?? ""];
    if (svar.trade_id && erSagType(type) && beskedType) {
      const v = Number(svar.version ?? (await version(admin, sagId)));
      const tradeId = svar.trade_id;
      const frist = svar.penge_flyttes_efter_kl ?? null;
      after(() => notificerSagAfgoerelse(sagId, tradeId, type, beskedType, begrundelse, v, frist));
    }

    revalider(sagId, svar.trade_id);
    return { ok: true as const, besked };
  });
}

// "Retur afleveret" (indtil GLS-sporingen er bygget): staff registrerer, at
// køberens returpakke er afleveret. Er ankefristen udløbet, claimes
// refusionen straks og sendes til Stripe; ellers sker det, når fristen er
// udløbet (cron). formData: sagId, note (valgfri, intern).
export async function registrerReturAfleveret(formData: FormData): Promise<Udfald | { fejl: string }> {
  return koer("registrerReturAfleveret", async () => {
    const { admin, userId } = await assertRole(AFGOER_ROLLE);
    const sagId = tekst(formData, "sagId");
    const note = tekst(formData, "note") || tekst(formData, "aarsag");
    if (!erUuid(sagId)) throw new BrugerFejl("Sagen findes ikke.");
    if (note.length > 2000) throw new BrugerFejl(KODE_FEJL.for_lang_tekst);

    const { data, error } = await admin.rpc("sag_retur_afleveret", {
      p_medarbejder: userId,
      p_sag: sagId,
      p_note: note || null,
    });
    if (error) throw new Error(error.message);
    const svar = (data ?? { kode: "" }) as RpcSvar;
    if (svar.kode !== "ok") throw new BrugerFejl(kodeFejl(svar.kode));

    let besked: string;
    let beskedType: SagUdfaldBesked | null = null;
    if (svar.handling === "refunder" && svar.betaling_id) {
      besked = await refunderNu(svar.betaling_id);
      beskedType = "refunderet";
    } else if (svar.handling === "refusion_blokeret") {
      besked = `Returpakken er registreret, men refusionen kan ikke gennemføres: ${fejlNavn(svar.grund)}. Betalingen er markeret til admin, og refusionen prøves igen automatisk.`;
    } else {
      besked = `Returpakken er registreret. Køberen refunderes tidligst ${fristTekst(svar)}, når ankefristen er udløbet.`;
      beskedType = "retur_afleveret";
    }

    const type = svar.type;
    if (svar.trade_id && erSagType(type) && beskedType) {
      const v = Number(svar.version ?? (await version(admin, sagId)));
      const tradeId = svar.trade_id;
      const frist = svar.penge_flyttes_efter_kl ?? null;
      const bt = beskedType;
      after(() => notificerSagAfgoerelse(sagId, tradeId, type, bt, null, v, frist));
    }

    revalider(sagId, svar.trade_id);
    return { ok: true as const, besked };
  });
}

// Admin/chef: genåbn en afgjort eller lukket sag. Kun hvis ingen penge er
// flyttet; inden for ankefristen annulleres den planlagte refusion/udbetaling.
// Pengene fryses (igen). formData: sagId, aarsag (påkrævet).
export async function genaabnSag(formData: FormData): Promise<Udfald | { fejl: string }> {
  return koer("genaabnSag", async () => {
    const { admin, userId } = await assertRole("admin");
    const sagId = tekst(formData, "sagId");
    const aarsag = tekst(formData, "aarsag") || tekst(formData, "begrundelse");
    if (!erUuid(sagId)) throw new BrugerFejl("Sagen findes ikke.");
    if (!aarsag) throw new BrugerFejl("Skriv, hvorfor sagen genåbnes.");
    if (aarsag.length > SAG_BEGRUNDELSE_MAKS) throw new BrugerFejl(KODE_FEJL.for_lang_tekst);

    const { data, error } = await admin.rpc("sag_genaabn", {
      p_medarbejder: userId,
      p_sag: sagId,
      p_begrundelse: aarsag,
    });
    if (error) throw new Error(error.message);
    const svar = (data ?? { kode: "" }) as RpcSvar;
    if (svar.kode !== "ok") throw new BrugerFejl(kodeFejl(svar.kode));

    const type = svar.type;
    if (svar.trade_id && erSagType(type)) {
      const v = Number(svar.version ?? (await version(admin, sagId)));
      const tradeId = svar.trade_id;
      after(() => notificerSagAfgoerelse(sagId, tradeId, type, "genaabnet", null, v));
    }

    revalider(sagId, svar.trade_id);
    return {
      ok: true as const,
      besked: svar.annulleret_planlagt
        ? "Sagen er genåbnet. Den planlagte flytning af pengene er annulleret, og pengene er frosset."
        : "Sagen er genåbnet, og pengene er frosset igen.",
    };
  });
}

// ------------------------------------------------------------------ Konto

// Admin/chef: luk en konto permanent (fx svindel). Suspenderet uden slutdato;
// kan ikke ophæves fra admin. formData: userId, aarsag (påkrævet), sagId (valgfri).
export async function lukKontoPermanent(formData: FormData): Promise<Udfald | { fejl: string }> {
  return koer("lukKontoPermanent", async () => {
    const { admin, userId: staffId } = await assertRole("admin");
    const brugerId = tekst(formData, "userId");
    const aarsag = tekst(formData, "aarsag");
    const sagId = tekst(formData, "sagId");
    if (!erUuid(brugerId)) throw new BrugerFejl(KODE_FEJL.ugyldig_bruger);
    if (sagId && !erUuid(sagId)) throw new BrugerFejl("Sagen findes ikke.");
    if (!aarsag) throw new BrugerFejl(KODE_FEJL.aarsag_mangler);
    if (aarsag.length > 1000) throw new BrugerFejl(KODE_FEJL.for_lang_tekst);

    const { data, error } = await admin.rpc("bruger_luk_konto_permanent", {
      p_medarbejder: staffId,
      p_bruger: brugerId,
      p_aarsag: aarsag,
      p_sag: sagId || null,
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode: string } | null)?.kode;
    if (kode !== "ok") throw new BrugerFejl(kodeFejl(kode));

    revalidatePath("/admin/brugere");
    revalidatePath(`/admin/brugere/${brugerId}`);
    if (sagId) revalidatePath(adminSagSti(sagId));
    return { ok: true as const, besked: "Kontoen er lukket permanent." };
  });
}

// ------------------------------------------------------------------ Chat

// Åbn (eller genbrug) en intern samtale om sagen med køber eller sælger.
// Samtalen knyttes til sagen (sag_type 'sag', sag_id) og handlen.
export async function aabnSagChat(
  sagId: string,
  part: "koeber" | "saelger",
  besked?: string | null,
): Promise<{ ok: true; samtaleId: string; fandtes: boolean } | { fejl: string }> {
  const forud = await koer("aabnSagChat", async () => {
    const { admin } = await assertRole("medarbejder");
    if (!erUuid(sagId)) throw new BrugerFejl("Sagen findes ikke.");
    if (part !== "koeber" && part !== "saelger") throw new BrugerFejl("Vælg køber eller sælger.");
    const { data: s } = await admin
      .from("sager")
      .select("trade_id, type")
      .eq("id", sagId)
      .maybeSingle<{ trade_id: string; type: string }>();
    if (!s || !erSagType(s.type)) throw new BrugerFejl("Sagen findes ikke.");
    const { data: t } = await admin
      .from("trades")
      .select("buyer_id, seller_id, auction_id")
      .eq("id", s.trade_id)
      .single<{ buyer_id: string; seller_id: string; auction_id: string }>();
    if (!t) throw new BrugerFejl("Handlen findes ikke.");
    const { data: a } = await admin.from("auctions").select("titel").eq("id", t.auction_id).maybeSingle();
    const titel = ((a?.titel as string | undefined) ?? "handel").slice(0, 120);
    return {
      brugerId: part === "koeber" ? t.buyer_id : t.seller_id,
      tradeId: s.trade_id,
      emne: `Sag: ${titel} (${SAG_TYPE_NAVN[s.type].split(" (")[0].toLowerCase()})`.slice(0, 200),
    };
  });
  if ("fejl" in forud) return forud;
  return aabnChat(forud.brugerId, forud.emne, {
    tradeId: forud.tradeId,
    sagType: SAG_CHAT_TYPE,
    sagId,
    besked: besked ?? null,
  });
}
