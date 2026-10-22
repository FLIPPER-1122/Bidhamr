import "server-only";

// Beskeder til SÆLGEREN om reklamationen hos fragtfirmaet (type 'sag' -
// påkrævet; altid også mail). Køberen får ingen. BidHamr anmelder, og
// chefen udbetaler (Filip, 22. okt. 2026) - sælgeren skal ikke gøre noget,
// men får besked ved hvert trin. Ingen omtale af omdeling.info.
//
// Reklamationen oprettes i databasen (trigger på sager + cron, først når
// køberen er refunderet, og afgørelsen er endelig), så beskederne udledes af
// tidsstemplerne - samme mønster som advarsler (src/lib/notifikationer/cron.ts).
// Hver hændelse har en fast nøgle, så den aldrig sendes to gange:
//   reklamation:<id>:oprettet:<aktiv_fra_kl>      - "Vi reklamerer hos DAO for dig"
//                                                   (ny nøgle, når den genopstår)
//   reklamation:<id>:anmeldt:<anmeldt_kl>         - skaden er anmeldt
//   reklamation:<id>:godkendt:<afgjort_kl>        - godkendt (beløb; udbetales,
//                                                   når fragtfirmaet har betalt os)
//   reklamation:<id>:afvist:<afgjort_kl>          - afvist (grund)
//   reklamation:<id>:sendt:<bank_payout_id>       - "Erstatningen er sendt til din
//                                                   bank" - først når payouten er
//                                                   oprettet/paid (én pr. payout;
//                                                   intet ved transferen alene)
//   reklamation:<id>:bank_fejlet:<bank_fejlet_kl> - udbetalingen til banken fejlede
//                                                   (sælgeren retter bankkontoen)
//   reklamation:<id>:bank_problem:<bank_fejlet_kl> - payouten er fejlet endeligt
//                                                   (annulleret/afvist hos Stripe)
//   reklamation:<id>:transfer_problem:<transfer_tilbagefoert_kl> - transferen er
//                                                   tilbageført hos Stripe
//     (begge: neutral besked - "vi kigger på det")
//   reklamation:<id>:annulleret:<annulleret_kl>   - staff har stoppet den
//   reklamation:<id>:auto_annulleret:<annulleret_kl> - systemet har stoppet den
//                                                   (kun hvis "oprettet" blev sendt)
//   reklamation:<id>:sag_aendret:<sag_aendret_kl> - sagen er ændret efter anmeldelsen
//   reklamation:<id>:kvitteret:<kvitteret_kl>     - reklamationen fortsætter (kun
//                                                   hvis "sag_aendret" for samme
//                                                   markering blev sendt)
// En hurtig fortrydelse (fx staff fortryder "ordentlig" og vurderer igen)
// giver ingen dobbelt-besked: "auto_annulleret" sendes først, når
// reklamationen har været stoppet i AUTO_STOP_VENT, og genåbnes den inden for
// samme tid, beholder den sin aktiv_fra_kl (fragt_reklamation_synkroniser),
// så "oprettet"-nøglen er den samme.
// Kaldes fra notifikations-cron'en (hvert 5. minut) og med after() efter
// staff-handlinger og sagsafgørelser. Før beskederne synkroniseres
// reklamationerne i databasen (fragt_reklamationer_synkroniser_alle).
// Kaster aldrig. Kun offentlige felter - ALDRIG intern_note eller sagsnummer.
import { createAdminClient } from "@/lib/supabase/admin";
import { send, type NotifikationInput } from "@/lib/notifikationer/send";
import { sagLink } from "@/lib/sager";
import { BIDHAMR_SYSTEM_ID } from "@/lib/staffChat";
import { kroner, transportoerNavn, type ReklamationStatus, type ReklamationTransportoer } from "@/lib/reklamation/typer";

const DAG = 24 * 3600 * 1000;
// Skal matche vinduet i fragt_reklamation_synkroniser (genåbning inden for
// 1 time beholder aktiv_fra_kl).
export const AUTO_STOP_VENT = 3600 * 1000;
const MAKS = 300;

export type ReklamationBeskedRaekke = {
  id: string;
  trade_id: string;
  saelger_id: string;
  transportoer: ReklamationTransportoer;
  status: ReklamationStatus;
  kravbeloeb_oere: number;
  godkendt_beloeb_oere?: number | null;
  afvisningsgrund?: string | null;
  annulleret_grund: string | null;
  annulleret_auto: boolean;
  annulleret_kl: string | null;
  aktiv_fra_kl: string;
  anmeldt_kl?: string | null;
  afgjort_kl?: string | null;
  udbetalt_kl?: string | null;
  bank_status?: string | null;
  bank_payout_id?: string | null;
  bank_fejlet_kl?: string | null;
  transfer_tilbagefoert_kl?: string | null;
  sag_aendret_kl: string | null;
  sag_aendret_kvitteret_kl: string | null;
  // Hvem der kvitterede (systemet eller staff) - styrer teksten.
  sag_aendret_kvitteret_af?: string | null;
};

// kraever: sendes kun, hvis beskeden med den nøgle allerede ER sendt.
type Opgave = { brugerId: string; input: NotifikationInput & { noegle: string }; kraever?: string };

const FELTER =
  "id, trade_id, saelger_id, transportoer, status, kravbeloeb_oere, godkendt_beloeb_oere, afvisningsgrund, annulleret_grund, annulleret_auto, annulleret_kl, aktiv_fra_kl, anmeldt_kl, afgjort_kl, udbetalt_kl, bank_status, bank_payout_id, bank_fejlet_kl, transfer_tilbagefoert_kl, sag_aendret_kl, sag_aendret_kvitteret_kl, sag_aendret_kvitteret_af";

const SPOERGSMAAL = "Har du spørgsmål, så skriv til support@bidhamr.dk.";

function punktum(t: string): string {
  const s = t.trim();
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

// Teksterne (eksporteret til test og til indhold-agenten). nu: til test.
export function reklamationBeskeder(r: ReklamationBeskedRaekke, nu: number = Date.now()): Opgave[] {
  const navn = transportoerNavn(r.transportoer);
  // Reklamationskortet på handlen. En automatisk stoppet reklamation vises
  // ikke for sælgeren, så den besked peger på sagen i stedet.
  const link = `/mine-handler/${r.trade_id}#reklamation`;
  const data = { trade_id: r.trade_id, reklamation_id: r.id };
  const ud: Opgave[] = [];
  const noegle = (n: string) => `reklamation:${r.id}:${n}`;
  const op = (n: string, titel: string, tekst: string, kraever?: string, til: string = link) =>
    ud.push({ brugerId: r.saelger_id, input: { titel, tekst, link: til, data, noegle: noegle(n) }, kraever });
  const oprettetNoegle = `oprettet:${ms(r.aktiv_fra_kl)}`;
  const aendretUkvitteret = !!r.sag_aendret_kl && !r.sag_aendret_kvitteret_kl;
  const beloeb = r.godkendt_beloeb_oere != null ? kroner(r.godkendt_beloeb_oere) : null;

  // Kun mens den venter på BidHamr. Ny nøgle pr. aktivering, så en
  // genopstået reklamation giver en ny besked.
  if (r.status === "afventer_bidhamr") {
    op(
      oprettetNoegle,
      `Vi reklamerer hos ${navn} for dig`,
      `Varen blev skadet under fragten, og køberen har fået pengene tilbage. Dine pakkebilleder viser, at du pakkede varen ordentligt, så BidHamr reklamerer hos ${navn} for dig – du skal ikke selv gøre noget. Vi kræver op til ${kroner(r.kravbeloeb_oere)} i erstatning. Det er ${navn}, der afgør, om du får erstatning. Du hører fra os, når der er nyt.`,
    );
  }
  if (r.status === "anmeldt" && r.anmeldt_kl) {
    op(
      `anmeldt:${ms(r.anmeldt_kl)}`,
      `Skaden er anmeldt hos ${navn}`,
      `Vi har anmeldt skaden hos ${navn} og sendt dine og køberens billeder med. Vi giver dig besked, når ${navn} har svaret.`,
    );
  }
  if (r.status === "godkendt" && r.afgjort_kl && beloeb) {
    op(
      `godkendt:${ms(r.afgjort_kl)}`,
      `${navn} har godkendt erstatningen`,
      `${navn} har godkendt en erstatning på ${beloeb} Vi udbetaler pengene til dig, når ${navn} har betalt os. Du får besked, når pengene er på vej.`,
    );
  }
  if (r.status === "afvist" && r.afgjort_kl) {
    op(
      `afvist:${ms(r.afgjort_kl)}`,
      `${navn} har afvist reklamationen`,
      `${navn} har afvist reklamationen, så du får desværre ikke erstatning for varen.${r.afvisningsgrund ? ` Begrundelse fra ${navn}: ${punktum(r.afvisningsgrund)}` : ""} ${SPOERGSMAAL}`,
    );
  }
  const tilbagefoert = !!r.transfer_tilbagefoert_kl;
  // Først når payouten til banken er oprettet (eller betalt) - én pr. payout.
  if (
    r.status === "udbetalt" &&
    !tilbagefoert &&
    (r.bank_status === "oprettet" || r.bank_status === "paid") &&
    r.bank_payout_id &&
    beloeb
  ) {
    op(
      `sendt:${r.bank_payout_id}`,
      "Erstatningen er sendt til din bank",
      `Vi har sendt ${beloeb} i erstatning til din bankkonto via vores betalingspartner Stripe. Der går normalt 1-3 bankdage, før pengene står på din konto.`,
    );
  }
  // Transferen er tilbageført, eller payouten er fejlet endeligt: neutral
  // besked (aldrig Stripe-detaljer) - chefen har en rød lampe.
  const problem = "Der er opstået et problem med udbetalingen af din erstatning – vi kigger på det og giver dig besked.";
  if (r.status === "udbetalt" && tilbagefoert) {
    op(`transfer_problem:${ms(r.transfer_tilbagefoert_kl!)}`, "Udbetalingen af din erstatning behandles", problem);
  }
  if (
    r.status === "udbetalt" &&
    !tilbagefoert &&
    (r.bank_status === "canceled" || r.bank_status === "afvist") &&
    r.bank_fejlet_kl
  ) {
    op(`bank_problem:${ms(r.bank_fejlet_kl)}`, "Udbetalingen af din erstatning behandles", problem);
  }
  if (r.status === "udbetalt" && !tilbagefoert && r.bank_status === "failed" && r.bank_fejlet_kl) {
    op(
      `bank_fejlet:${ms(r.bank_fejlet_kl)}`,
      "Udbetalingen til din bank fejlede",
      "Vores betalingspartner Stripe kunne ikke sende erstatningen til din bankkonto. Ret dine bankoplysninger hos Stripe – du finder dem under Min konto. Når bankkontoen er rettet, sendes pengene automatisk igen.",
      undefined,
      "/konto#udbetaling",
    );
  }
  if (r.status === "annulleret" && !r.annulleret_auto && r.annulleret_kl) {
    op(
      `annulleret:${ms(r.annulleret_kl)}`,
      "Reklamationen er stoppet",
      `BidHamr har stoppet reklamationen hos ${navn}.${r.annulleret_grund ? ` Begrundelse: ${punktum(r.annulleret_grund)}` : ""} ${SPOERGSMAAL}`,
    );
  }
  // Systemet har stoppet den (sagen er ændret, før skaden blev anmeldt). Kun
  // hvis sælgeren fik "oprettet" for netop denne aktivering.
  // Først efter AUTO_STOP_VENT: genåbnes den inden da, får sælgeren hverken
  // "stoppet" eller et nyt "Vi reklamerer for dig".
  if (r.status === "annulleret" && r.annulleret_auto && r.annulleret_kl && nu - ms(r.annulleret_kl) >= AUTO_STOP_VENT) {
    op(
      `auto_annulleret:${ms(r.annulleret_kl)}`,
      "Reklamationen er stoppet",
      `Sagen om handlen er ændret, så vi reklamerer ikke hos ${navn} alligevel. ${SPOERGSMAAL}`,
      noegle(oprettetNoegle),
      sagLink(r.trade_id),
    );
  }
  if (aendretUkvitteret && (r.status === "anmeldt" || r.status === "godkendt")) {
    op(
      `sag_aendret:${ms(r.sag_aendret_kl!)}`,
      "Sagen om din handel er ændret",
      `Sagen om handlen er ændret, efter vi anmeldte skaden hos ${navn}. Vi kigger på, hvad det betyder for reklamationen, og giver dig besked.`,
    );
  }
  // Kun hvis "sag_aendret" for netop denne markering er sendt. Teksten
  // afhænger af, om staff eller systemet (betingelserne opfyldt igen) kvitterede.
  if ((r.status === "anmeldt" || r.status === "godkendt") && r.sag_aendret_kl && r.sag_aendret_kvitteret_kl) {
    const afSystemet = (r.sag_aendret_kvitteret_af ?? "").toLowerCase() === BIDHAMR_SYSTEM_ID;
    op(
      `kvitteret:${ms(r.sag_aendret_kvitteret_kl)}`,
      `Reklamationen hos ${navn} fortsætter`,
      afSystemet
        ? `Reklamationen hos ${navn} fortsætter som før. Du hører fra os, når der er nyt.`
        : `Vi har kigget på sagen, og reklamationen hos ${navn} fortsætter som før. Du hører fra os, når der er nyt.`,
      noegle(`sag_aendret:${ms(r.sag_aendret_kl)}`),
    );
  }
  return ud;
}

async function sendOpgaver(admin: ReturnType<typeof createAdminClient>, opgaver: Opgave[]): Promise<number> {
  if (opgaver.length === 0) return 0;
  const sendt = new Set<string>();
  const noegler = [...new Set(opgaver.flatMap((o) => (o.kraever ? [o.input.noegle, o.kraever] : [o.input.noegle])))];
  for (let i = 0; i < noegler.length; i += 200) {
    const { data, error } = await admin
      .from("notifikation_afsendelser")
      .select("noegle")
      .in("noegle", noegler.slice(i, i + 200));
    if (error) {
      console.error("Reklamation: opslag af sendte beskeder fejlede:", error.message);
      return 0;
    }
    for (const r of data ?? []) sendt.add(r.noegle as string);
  }
  let antal = 0;
  for (const o of opgaver) {
    if (sendt.has(o.input.noegle)) continue;
    if (o.kraever && !sendt.has(o.kraever)) continue;
    // Påkrævet type: sendes, selv om nøglen ikke kan claimes af ukendt årsag.
    const r = await send(o.brugerId, "sag", o.input, { springOverVedClaimFejl: true, altidMail: true });
    if (!r.dublet && !r.sprunget) antal++;
  }
  return antal;
}

// Opret/annullér/genopliv reklamationer, hvor betingelserne har ændret sig
// uden en ændring på sagen (refusion bekræftet/fejlet, ankefrist udløbet).
async function synkroniser(admin: ReturnType<typeof createAdminClient>): Promise<void> {
  const { error } = await admin.rpc("fragt_reklamationer_synkroniser_alle", { p_graense: 200 });
  // PGRST202/42883: migrationen er ikke kørt endnu.
  if (error && !["PGRST202", "42883"].includes(error.code ?? "")) {
    console.error("Reklamation: synkronisering fejlede:", error.message);
  }
}

export async function notificerReklamationer(): Promise<number> {
  try {
    const admin = createAdminClient();
    await synkroniser(admin);
    const nu = Date.now();
    const [nye, spaerrede] = await Promise.all([
      // Ændret inden for 48 timer: alle trin. Nyeste først, så en stor bunke
      // aldrig skubber de seneste ændringer ud (de ældre er behandlet i
      // tidligere kørsler).
      admin
        .from("fragt_reklamationer")
        .select(FELTER)
        .gte("opdateret_kl", new Date(nu - 2 * DAG).toISOString())
        .order("opdateret_kl", { ascending: false })
        .limit(MAKS),
      // Sagen ændret, ikke kvitteret - uanset alder, så sælgeren altid får
      // besked.
      admin
        .from("fragt_reklamationer")
        .select(FELTER)
        .in("status", ["anmeldt", "godkendt"])
        .not("sag_aendret_kl", "is", null)
        .is("sag_aendret_kvitteret_kl", null)
        .limit(MAKS),
    ]);
    for (const r of [nye, spaerrede]) {
      if (r.error) {
        // 42P01/PGRST205: migrationen er ikke kørt endnu.
        if (r.error.code !== "42P01" && r.error.code !== "PGRST205") {
          console.error("Reklamation: beskeder kunne ikke hentes:", r.error.message);
        }
        return 0;
      }
    }
    const raekker = new Map<string, ReklamationBeskedRaekke>();
    for (const r of [...(nye.data ?? []), ...(spaerrede.data ?? [])] as ReklamationBeskedRaekke[]) raekker.set(r.id, r);
    const opgaver = [...raekker.values()].flatMap((r) => reklamationBeskeder(r, nu));
    return await sendOpgaver(admin, opgaver);
  } catch (err) {
    console.error("Reklamation: beskeder fejlede:", err);
    return 0;
  }
}
