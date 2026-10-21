import "server-only";

// Beskeder til SÆLGEREN om reklamationen hos fragtfirmaet (type 'sag' -
// påkrævet; altid også mail, Filip 21. okt. 2026). Køberen får ingen.
//
// Reklamationen oprettes i databasen (også automatisk fra en trigger, når
// sagen afgøres), så beskederne udledes af tidsstemplerne - samme mønster som
// advarsler (src/lib/notifikationer/cron.ts). Hver hændelse har en fast nøgle,
// så den aldrig sendes to gange:
//   reklamation:<id>:oprettet                 - "Du kan få erstatning ..."
//   reklamation:<id>:gensendt:<antal>         - staff har sendt pakken igen
//   reklamation:<id>:paamind:<aktiv_fra_kl>   - 7 dage uden "anmeldt"
//   reklamation:<id>:annulleret:<annulleret_kl> - staff har stoppet den
// Kaldes fra notifikations-cron'en (hvert 5. minut) og med after() efter
// staff-handlinger og sagsafgørelser. Kaster aldrig.
// Kun offentlige felter - ALDRIG intern_note.
import { createAdminClient } from "@/lib/supabase/admin";
import { send, type NotifikationInput } from "@/lib/notifikationer/send";
import { sagLink } from "@/lib/sager";
import {
  REKLAMATION_ANMELD,
  REKLAMATION_PAAMIND_DAGE,
  kroner,
  transportoerNavn,
  type ReklamationStatus,
  type ReklamationTransportoer,
} from "@/lib/reklamation/typer";

const DAG = 24 * 3600 * 1000;
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
};

type Opgave = { brugerId: string; input: NotifikationInput & { noegle: string } };

const FELTER =
  "id, trade_id, saelger_id, transportoer, status, kravbeloeb_oere, annulleret_grund, annulleret_auto, annulleret_kl, aktiv_fra_kl, gensendt_antal";

function punktum(t: string): string {
  const s = t.trim();
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function anmeldTekst(r: ReklamationBeskedRaekke): string {
  const navn = transportoerNavn(r.transportoer);
  const sted = REKLAMATION_ANMELD[r.transportoer]?.url
    ? ` på ${REKLAMATION_ANMELD[r.transportoer].url!.replace(/^https?:\/\//, "")}`
    : "";
  return `Anmeld skaden hos ${navn}${sted}. Du kan kræve op til ${kroner(r.kravbeloeb_oere)}. På handlen finder du alle oplysninger og billeder samlet, klar til at sende. Erstatningen udbetaler ${navn} direkte til dig.`;
}

// Teksterne (eksporteret til test og til indhold-agenten). nu: til test.
export function reklamationBeskeder(r: ReklamationBeskedRaekke, nu: number = Date.now()): Opgave[] {
  const navn = transportoerNavn(r.transportoer);
  const link = sagLink(r.trade_id);
  const data = { trade_id: r.trade_id, reklamation_id: r.id };
  const ud: Opgave[] = [];
  const op = (noegle: string, titel: string, tekst: string) =>
    ud.push({ brugerId: r.saelger_id, input: { titel, tekst, link, data, noegle: `reklamation:${r.id}:${noegle}` } });
  const aaben = r.status === "afventer_saelger" || r.status === "anmeldt";

  // Ikke, hvis systemet annullerede den, før beskeden blev sendt.
  if (!(r.status === "annulleret" && r.annulleret_auto)) {
    op(
      "oprettet",
      `Du kan få erstatning fra ${navn}`,
      `Varen blev skadet under fragten, og din indpakning var i orden. ${anmeldTekst(r)}`,
    );
  }
  if (aaben && r.gensendt_antal > 0) {
    op(`gensendt:${r.gensendt_antal}`, `Husk at anmelde skaden hos ${navn}`, anmeldTekst(r));
  }
  if (r.status === "afventer_saelger" && nu - new Date(r.aktiv_fra_kl).getTime() >= REKLAMATION_PAAMIND_DAGE * DAG) {
    op(
      `paamind:${new Date(r.aktiv_fra_kl).getTime()}`,
      `Har du anmeldt skaden hos ${navn}?`,
      `${anmeldTekst(r)} Har du allerede anmeldt den, så tryk "Anmeldt" på handlen. Vil du ikke reklamere, kan du også vælge det dér.`,
    );
  }
  if (r.status === "annulleret" && !r.annulleret_auto && r.annulleret_kl) {
    op(
      `annulleret:${new Date(r.annulleret_kl).getTime()}`,
      "Reklamationen er stoppet",
      `BidHamr har stoppet reklamationen hos ${navn}.${r.annulleret_grund ? ` Begrundelse: ${punktum(r.annulleret_grund)}` : ""} Kontakt support@bidhamr.dk, hvis du har spørgsmål.`,
    );
  }
  return ud;
}

async function sendOpgaver(admin: ReturnType<typeof createAdminClient>, opgaver: Opgave[]): Promise<number> {
  if (opgaver.length === 0) return 0;
  const sendt = new Set<string>();
  for (let i = 0; i < opgaver.length; i += 200) {
    const { data, error } = await admin
      .from("notifikation_afsendelser")
      .select("noegle")
      .in("noegle", opgaver.slice(i, i + 200).map((o) => o.input.noegle));
    if (error) {
      console.error("Reklamation: opslag af sendte beskeder fejlede:", error.message);
      return 0;
    }
    for (const r of data ?? []) sendt.add(r.noegle as string);
  }
  let antal = 0;
  for (const o of opgaver) {
    if (sendt.has(o.input.noegle)) continue;
    // Påkrævet type: sendes, selv om nøglen ikke kan claimes af ukendt årsag.
    const r = await send(o.brugerId, "sag", o.input, { springOverVedClaimFejl: true, altidMail: true });
    if (!r.dublet && !r.sprunget) antal++;
  }
  return antal;
}

export async function notificerReklamationer(): Promise<number> {
  try {
    const admin = createAdminClient();
    const nu = Date.now();
    const [nye, gamle] = await Promise.all([
      // Ændret inden for 48 timer: oprettet, gensendt, annulleret.
      admin
        .from("fragt_reklamationer")
        .select(FELTER)
        .gte("opdateret_kl", new Date(nu - 2 * DAG).toISOString())
        .order("opdateret_kl", { ascending: true })
        .limit(MAKS),
      // Påmindelse: venter på sælgeren i 7+ dage (højst 60 dage tilbage).
      admin
        .from("fragt_reklamationer")
        .select(FELTER)
        .eq("status", "afventer_saelger")
        .lte("aktiv_fra_kl", new Date(nu - REKLAMATION_PAAMIND_DAGE * DAG).toISOString())
        .gte("aktiv_fra_kl", new Date(nu - 60 * DAG).toISOString())
        .limit(MAKS),
    ]);
    for (const r of [nye, gamle]) {
      if (r.error) {
        // 42P01/PGRST205: migrationen er ikke kørt endnu.
        if (r.error.code !== "42P01" && r.error.code !== "PGRST205") {
          console.error("Reklamation: beskeder kunne ikke hentes:", r.error.message);
        }
        return 0;
      }
    }
    const raekker = new Map<string, ReklamationBeskedRaekke>();
    for (const r of [...(nye.data ?? []), ...(gamle.data ?? [])] as ReklamationBeskedRaekke[]) raekker.set(r.id, r);
    const opgaver = [...raekker.values()].flatMap((r) => reklamationBeskeder(r, nu));
    return await sendOpgaver(admin, opgaver);
  } catch (err) {
    console.error("Reklamation: beskeder fejlede:", err);
    return 0;
  }
}
