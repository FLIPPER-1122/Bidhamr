import "server-only";

// Beskeder til SÆLGEREN om reklamationen hos fragtfirmaet (type 'sag' -
// påkrævet; altid også mail, Filip 21. okt. 2026). Køberen får ingen.
//
// Reklamationen oprettes i databasen (trigger på sager + cron, først når
// køberen er refunderet, og afgørelsen er endelig), så beskederne udledes af
// tidsstemplerne - samme mønster som advarsler (src/lib/notifikationer/cron.ts).
// Hver hændelse har en fast nøgle, så den aldrig sendes to gange:
//   reklamation:<id>:oprettet:<aktiv_fra_kl>      - "Du kan søge erstatning ..."
//                                                   (ny nøgle, når den genopstår)
//   reklamation:<id>:gensendt:<antal>             - staff har sendt pakken igen
//   reklamation:<id>:paamind:<aktiv_fra_kl>       - 7 dage uden "anmeldt"
//   reklamation:<id>:annulleret:<annulleret_kl>   - staff har stoppet den
//   reklamation:<id>:auto_annulleret:<annulleret_kl> - systemet har stoppet den
//                                                   (kun hvis "oprettet" blev sendt)
//   reklamation:<id>:sag_aendret:<sag_aendret_kl> - sagen er ændret efter anmeldelsen
//   reklamation:<id>:kvitteret:<kvitteret_kl>     - du kan fortsætte (anmeldt; kun
//                                                   hvis "sag_aendret" for samme
//                                                   markering blev sendt)
// En hurtig fortrydelse (fx staff fortryder "ordentlig" og vurderer igen)
// giver ingen dobbelt-besked: "auto_annulleret" sendes først, når
// reklamationen har været stoppet i AUTO_STOP_VENT, og genåbnes den inden for
// samme tid, beholder den sin aktiv_fra_kl (fragt_reklamation_synkroniser),
// så "oprettet"-nøglen er den samme.
// Kaldes fra notifikations-cron'en (hvert 5. minut) og med after() efter
// staff-handlinger og sagsafgørelser. Før beskederne synkroniseres
// reklamationerne i databasen (fragt_reklamationer_synkroniser_alle), så en
// reklamation oprettes, når refusionen er bekræftet, eller ankefristen er
// udløbet. Kaster aldrig.
// Kun offentlige felter - ALDRIG intern_note.
import { createAdminClient } from "@/lib/supabase/admin";
import { send, type NotifikationInput } from "@/lib/notifikationer/send";
import { sagLink } from "@/lib/sager";
import { BIDHAMR_SYSTEM_ID } from "@/lib/staffChat";
import {
  REKLAMATION_ANMELD,
  REKLAMATION_PAAMIND_DAGE,
  kroner,
  transportoerNavn,
  type ReklamationStatus,
  type ReklamationTransportoer,
} from "@/lib/reklamation/typer";

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
  annulleret_grund: string | null;
  annulleret_auto: boolean;
  annulleret_kl: string | null;
  aktiv_fra_kl: string;
  gensendt_antal: number;
  sag_aendret_kl: string | null;
  sag_aendret_kvitteret_kl: string | null;
  // Hvem der kvitterede (systemet eller staff) - styrer teksten.
  sag_aendret_kvitteret_af?: string | null;
};

// kraever: sendes kun, hvis beskeden med den nøgle allerede ER sendt.
type Opgave = { brugerId: string; input: NotifikationInput & { noegle: string }; kraever?: string };

const FELTER =
  "id, trade_id, saelger_id, transportoer, status, kravbeloeb_oere, annulleret_grund, annulleret_auto, annulleret_kl, aktiv_fra_kl, gensendt_antal, sag_aendret_kl, sag_aendret_kvitteret_kl, sag_aendret_kvitteret_af";

function punktum(t: string): string {
  const s = t.trim();
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

function anmeldTekst(r: ReklamationBeskedRaekke): string {
  const navn = transportoerNavn(r.transportoer);
  const sted = REKLAMATION_ANMELD[r.transportoer]?.url
    ? ` på ${REKLAMATION_ANMELD[r.transportoer].url!.replace(/^https?:\/\//, "")}`
    : "";
  return `Anmeld skaden hos ${navn}${sted}. Du kan kræve op til ${kroner(r.kravbeloeb_oere)} På handlen ligger alle oplysninger og billeder samlet, så du kan kopiere dem direkte over. Det er ${navn}, der afgør, om du får erstatning, og pengene udbetales direkte fra ${navn} til dig.`;
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
  const aaben = r.status === "afventer_saelger" || r.status === "anmeldt";
  const oprettetNoegle = `oprettet:${ms(r.aktiv_fra_kl)}`;
  const aendretUkvitteret = !!r.sag_aendret_kl && !r.sag_aendret_kvitteret_kl;

  // Kun mens den venter på sælgeren (ikke efter annullering eller
  // registrering). Ny nøgle pr. aktivering, så en genopstået reklamation
  // giver en ny besked.
  if (r.status === "afventer_saelger") {
    op(
      oprettetNoegle,
      `Du kan søge erstatning hos ${navn}`,
      `Varen blev skadet under fragten, og køberen har fået pengene tilbage. Dine pakkebilleder viser, at du pakkede varen ordentligt, så du kan selv søge erstatning hos ${navn}. ${anmeldTekst(r)}`,
    );
  }
  if (aaben && r.gensendt_antal > 0) {
    op(
      `gensendt:${r.gensendt_antal}`,
      `Oplysninger til din skadeanmeldelse hos ${navn}`,
      `BidHamr har sendt dig oplysningerne igen. ${anmeldTekst(r)}`,
    );
  }
  if (r.status === "afventer_saelger" && nu - ms(r.aktiv_fra_kl) >= REKLAMATION_PAAMIND_DAGE * DAG) {
    op(
      `paamind:${ms(r.aktiv_fra_kl)}`,
      `Har du anmeldt skaden hos ${navn}?`,
      `Vi kan ikke se, at skaden er anmeldt endnu. ${anmeldTekst(r)} Har du allerede anmeldt den, så marker det på handlen. Vil du ikke søge erstatning, kan du også vælge det dér.`,
    );
  }
  if (r.status === "annulleret" && !r.annulleret_auto && r.annulleret_kl) {
    op(
      `annulleret:${ms(r.annulleret_kl)}`,
      "Reklamationen er stoppet",
      `BidHamr har stoppet reklamationen hos ${navn}.${r.annulleret_grund ? ` Begrundelse: ${punktum(r.annulleret_grund)}` : ""} Har du spørgsmål, så skriv til support@bidhamr.dk.`,
    );
  }
  // Systemet har stoppet den (sagen er ændret, før sælgeren anmeldte). Kun
  // hvis sælgeren fik "oprettet" for netop denne aktivering.
  // Først efter AUTO_STOP_VENT: genåbnes den inden da, får sælgeren hverken
  // "stoppet" eller et nyt "Du kan søge erstatning".
  if (r.status === "annulleret" && r.annulleret_auto && r.annulleret_kl && nu - ms(r.annulleret_kl) >= AUTO_STOP_VENT) {
    op(
      `auto_annulleret:${ms(r.annulleret_kl)}`,
      "Reklamationen er stoppet",
      `Sagen om handlen er ændret, så du skal ikke anmelde skaden hos ${navn} alligevel. Har du spørgsmål, så skriv til support@bidhamr.dk.`,
      noegle(oprettetNoegle),
      sagLink(r.trade_id),
    );
  }
  if (aendretUkvitteret && (r.status === "anmeldt" || r.status === "godkendt")) {
    op(
      `sag_aendret:${ms(r.sag_aendret_kl!)}`,
      "Sagen om din handel er ændret",
      r.status === "anmeldt"
        ? `Sagen om handlen er ændret, efter du anmeldte skaden hos ${navn}. BidHamr kigger på det og kontakter dig. Vent med at registrere, at erstatningen er godkendt, til du har hørt fra os.`
        : `Sagen om handlen er ændret, efter ${navn} godkendte din erstatning. BidHamr kigger på det og kontakter dig, hvis det får betydning for dig.`,
    );
  }
  // Kun hvis "sag_aendret" for netop denne markering er sendt. Teksten
  // afhænger af, om staff eller systemet (betingelserne opfyldt igen) kvitterede.
  if (r.status === "anmeldt" && r.sag_aendret_kl && r.sag_aendret_kvitteret_kl) {
    const afSystemet = (r.sag_aendret_kvitteret_af ?? "").toLowerCase() === BIDHAMR_SYSTEM_ID;
    op(
      `kvitteret:${ms(r.sag_aendret_kvitteret_kl)}`,
      `Du kan fortsætte din anmeldelse hos ${navn}`,
      afSystemet
        ? `Du kan fortsætte med din skadeanmeldelse hos ${navn}. Når ${navn} har svaret, så registrer svaret på handlen.`
        : `BidHamr har kigget på sagen, og din anmeldelse hos ${navn} kan fortsætte. Når ${navn} har svaret, så registrer svaret på handlen.`,
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
    const [nye, gamle, spaerrede] = await Promise.all([
      // Ændret inden for 48 timer: oprettet, gensendt, annulleret, sag ændret.
      // Nyeste først, så en stor bunke aldrig skubber de seneste ændringer ud
      // (de ældre er behandlet i tidligere kørsler).
      admin
        .from("fragt_reklamationer")
        .select(FELTER)
        .gte("opdateret_kl", new Date(nu - 2 * DAG).toISOString())
        .order("opdateret_kl", { ascending: false })
        .limit(MAKS),
      // Påmindelse: venter på sælgeren i 7+ dage (højst 60 dage tilbage).
      admin
        .from("fragt_reklamationer")
        .select(FELTER)
        .eq("status", "afventer_saelger")
        .lte("aktiv_fra_kl", new Date(nu - REKLAMATION_PAAMIND_DAGE * DAG).toISOString())
        .gte("aktiv_fra_kl", new Date(nu - 60 * DAG).toISOString())
        .limit(MAKS),
      // Spærret for "godkendt" (sagen ændret, ikke kvitteret) - uanset alder,
      // så sælgeren aldrig står spærret uden at have fået besked.
      admin
        .from("fragt_reklamationer")
        .select(FELTER)
        .in("status", ["anmeldt", "godkendt"])
        .not("sag_aendret_kl", "is", null)
        .is("sag_aendret_kvitteret_kl", null)
        .limit(MAKS),
    ]);
    for (const r of [nye, gamle, spaerrede]) {
      if (r.error) {
        // 42P01/PGRST205: migrationen er ikke kørt endnu.
        if (r.error.code !== "42P01" && r.error.code !== "PGRST205") {
          console.error("Reklamation: beskeder kunne ikke hentes:", r.error.message);
        }
        return 0;
      }
    }
    const raekker = new Map<string, ReklamationBeskedRaekke>();
    for (const r of [...(nye.data ?? []), ...(gamle.data ?? []), ...(spaerrede.data ?? [])] as ReklamationBeskedRaekke[]) raekker.set(r.id, r);
    const opgaver = [...raekker.values()].flatMap((r) => reklamationBeskeder(r, nu));
    return await sendOpgaver(admin, opgaver);
  } catch (err) {
    console.error("Reklamation: beskeder fejlede:", err);
    return 0;
  }
}
