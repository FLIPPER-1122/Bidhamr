import "server-only";

// Beskeder til SÆLGEREN om ekstra fragt (type 'betalingsfrist' - påkrævet;
// altid også mail). Migration 20261029020000_ekstra_fragt.sql.
//
// Regningerne ændres i databasen (staff, sælgeren, webhooken), så beskederne
// udledes af tidsstemplerne - samme mønster som reklamationer
// (src/lib/reklamation/notifikationer.ts). Hver hændelse har en fast nøgle,
// så den aldrig sendes to gange:
//   ekstrafragt:<id>:oprettet                  - ny regning (beløb, frist) - ikke,
//                                                hvis den allerede er betalt/frafaldet
//   ekstrafragt:<id>:paamind[:<runde>]         - 7 dage uden betaling (før fristen)
//   ekstrafragt:<id>:spaerret:<frist>          - fristen er overskredet: spærret
//   ekstrafragt:<id>:afgjort:<afgjort_kl>      - indsigelsen er afgjort (fastholdt/frafaldet)
//   ekstrafragt:<id>:frafaldet:<frafaldet_kl>  - frafaldet uden indsigelse eller
//                                                efter en fastholdt indsigelse
//   ekstrafragt:<id>:genaabnet:<genaabnet_kl>  - genåbnet efter tabt bankindsigelse
//   ekstrafragt:<id>:betalt[:<runde>]          - kvittering (pr. betalingsrunde)
// Kaldes fra notifikations-cron'en (hvert 5. minut) og med after() efter
// staff-handlinger og betalingen. Kaster aldrig. Kun offentlige felter -
// ALDRIG intern_note eller opmaerksomhed_tekst.
import { createAdminClient } from "@/lib/supabase/admin";
import { send, type NotifikationInput } from "@/lib/notifikationer/send";
import { sagSti } from "@/lib/sager";
import { kroner } from "@/lib/kroner";
import { EKSTRA_FRAGT_PAAMIND_DAGE, STOERRELSE_NAVN, type EkstraFragtStatus } from "@/lib/ekstraFragt/tekster";

const DAG = 24 * 3600 * 1000;
const MAKS = 300;

export type EkstraFragtBeskedRaekke = {
  id: string;
  trade_id: string;
  saelger_id: string;
  status: EkstraFragtStatus;
  beloeb_oere: number;
  valgt_stoerrelse: string;
  maalt_stoerrelse: string | null;
  maalt_vaegt_gram: number | null;
  frist: string;
  oprettet_kl: string;
  afgoerelse: "frafaldet" | "fastholdt" | null;
  afgoerelse_begrundelse: string | null;
  afgjort_kl: string | null;
  frafaldet_kl: string | null;
  frafald_grund: string | null;
  betalt_kl: string | null;
  // Betalingsrunde (0, eller 1, 2 ... efter genåbning) og seneste genåbning.
  runde?: number | null;
  genaabnet_kl?: string | null;
  genaabn_begrundelse?: string | null;
};

type Opgave = { brugerId: string; input: NotifikationInput & { noegle: string } };

const FELTER =
  "id, trade_id, saelger_id, status, beloeb_oere, valgt_stoerrelse, maalt_stoerrelse, maalt_vaegt_gram, frist, oprettet_kl, " +
  "afgoerelse, afgoerelse_begrundelse, afgjort_kl, frafaldet_kl, frafald_grund, betalt_kl, runde, genaabnet_kl, genaabn_begrundelse";

function punktum(t: string): string {
  const s = t.trim();
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function dato(iso: string): string {
  return new Intl.DateTimeFormat("da-DK", { timeZone: "Europe/Copenhagen", day: "numeric", month: "long", year: "numeric" }).format(
    new Date(iso),
  );
}

function maaling(r: EkstraFragtBeskedRaekke): string {
  const dele: string[] = [];
  if (r.maalt_stoerrelse) dele.push(STOERRELSE_NAVN[r.maalt_stoerrelse] ?? r.maalt_stoerrelse);
  if (r.maalt_vaegt_gram) dele.push(`${(r.maalt_vaegt_gram / 1000).toLocaleString("da-DK", { maximumFractionDigits: 3 })} kg`);
  return dele.join(", ");
}

// Teksterne (eksporteret til test og til indhold-agenten). nu: til test.
export function ekstraFragtBeskeder(r: EkstraFragtBeskedRaekke, nu: number = Date.now()): Opgave[] {
  const link = sagSti(r.trade_id);
  const data = { trade_id: r.trade_id, ekstra_fragt_id: r.id };
  const ud: Opgave[] = [];
  const op = (noegle: string, titel: string, tekst: string) =>
    ud.push({ brugerId: r.saelger_id, input: { titel, tekst, link, data, noegle: `ekstrafragt:${r.id}:${noegle}` } });
  const beloeb = kroner(Number(r.beloeb_oere));
  const valgt = STOERRELSE_NAVN[r.valgt_stoerrelse] ?? r.valgt_stoerrelse;
  const maalt = maaling(r);
  const frist = new Date(r.frist).getTime();

  const runde = Number(r.runde ?? 0);
  const genaabnet = runde > 0 && !!r.genaabnet_kl;

  // "Ny regning" kun, mens den stadig skal betales (eller er under
  // indsigelse) - ikke, hvis den allerede er betalt, frafaldet eller
  // refunderet, før beskeden blev sendt (så sælgeren ikke først får "betal" og
  // straks efter "frafaldet"/"tak"). Kun første runde (en genåbning har sin
  // egen besked).
  if (runde === 0 && (r.status === "afventer_betaling" || r.status === "behandles" || r.status === "indsigelse")) op(
    "oprettet",
    "Ekstra fragt: din pakke var større end den valgte størrelse",
    `Fragtfirmaet har målt en pakke, du har sendt. Du valgte ${valgt}${maalt ? `, men fragtfirmaet målte pakken til ${maalt}` : ", men pakken var større eller tungere"}. Derfor har fragtfirmaet opkrævet ekstra. Forskellen er ${beloeb}. Den betaler du som sælger. Betal på handlen senest ${dato(r.frist)}. Dér kan du også se fragtfirmaets dokumentation. Mener du, at målingen er forkert, kan du gøre indsigelse én gang på handlen. Betaler du ikke inden fristen, kan du ikke oprette nye auktioner, før beløbet er betalt.`,
  );

  // Genåbnet efter en tabt bankindsigelse (staff): betalingen er tilbageført.
  if (genaabnet && (r.status === "afventer_betaling" || r.status === "behandles" || r.status === "indsigelse")) {
    op(
      `genaabnet:${new Date(r.genaabnet_kl!).getTime()}`,
      "Ekstra fragt: din betaling er tilbageført – regningen er åbnet igen",
      `Din betaling på ${beloeb} for ekstra fragt er blevet tilbageført efter en indsigelse hos din bank eller dit kortselskab. Regningen er derfor åbnet igen. Betal den på handlen senest ${dato(r.frist)}.${r.genaabn_begrundelse ? ` Begrundelse: ${punktum(r.genaabn_begrundelse)}` : ""} Betaler du ikke inden fristen, kan du ikke sætte flere varer til salg, før beløbet er betalt.`,
    );
  }

  // Påmindelse 7 dage efter regningen (eller genåbningen), før fristen.
  const start = new Date(genaabnet ? r.genaabnet_kl! : r.oprettet_kl).getTime();
  if (r.status === "afventer_betaling" && nu < frist && nu - start >= EKSTRA_FRAGT_PAAMIND_DAGE * DAG) {
    op(
      runde === 0 ? "paamind" : `paamind:${runde}`,
      "Husk at betale for ekstra fragt",
      `Du mangler at betale ${beloeb} for ekstra fragt, fordi pakken var større eller tungere end den størrelse, du valgte. Fristen er ${dato(r.frist)}. Du betaler på handlen.${r.afgoerelse ? "" : " Mener du, at målingen er forkert, kan du gøre indsigelse dér."} Betaler du ikke inden fristen, kan du ikke oprette nye auktioner, før beløbet er betalt.`,
    );
  }

  if (r.status === "afventer_betaling" && nu >= frist) {
    op(
      `spaerret:${frist}`,
      "Du kan ikke oprette nye auktioner, før ekstra fragt er betalt",
      `Fristen for at betale ${beloeb} for ekstra fragt er overskredet. Indtil beløbet er betalt, kan du ikke oprette nye auktioner, sætte en vare op igen eller tilbyde en vare til næste byder. Dine aktive auktioner og handler fortsætter som normalt. Når du har betalt på handlen, kan du med det samme sætte varer til salg igen.`,
    );
  }

  if (r.afgoerelse && r.afgjort_kl) {
    const begrundelse = r.afgoerelse_begrundelse ? ` Begrundelse: ${punktum(r.afgoerelse_begrundelse)}` : "";
    if (r.afgoerelse === "fastholdt") {
      op(
        `afgjort:${new Date(r.afgjort_kl).getTime()}`,
        "Din indsigelse om ekstra fragt er afgjort",
        `Vi har set på din indsigelse og fastholder regningen på ${beloeb}.${begrundelse} Betal den på handlen senest ${dato(r.frist)}. Betaler du ikke inden fristen, kan du ikke oprette nye auktioner, før beløbet er betalt.`,
      );
    } else {
      op(
        `afgjort:${new Date(r.afgjort_kl).getTime()}`,
        "Din indsigelse om ekstra fragt er afgjort",
        `Vi har set på din indsigelse og giver dig ret. Regningen på ${beloeb} er frafaldet, og du skal ikke betale.${begrundelse}`,
      );
    }
  }
  // Frafaldet uden indsigelse - eller EFTER en fastholdt indsigelse (så er
  // afgørelsen 'fastholdt', og sælgeren skal stadig have besked om frafaldet).
  if (r.status === "frafaldet" && r.frafaldet_kl && r.afgoerelse !== "frafaldet") {
    op(
      `frafaldet:${new Date(r.frafaldet_kl).getTime()}`,
      "Regningen for ekstra fragt er frafaldet",
      `BidHamr har frafaldet regningen på ${beloeb} for ekstra fragt. Du skal ikke betale.${r.frafald_grund ? ` Begrundelse: ${punktum(r.frafald_grund)}` : ""}`,
    );
  }

  if ((r.status === "betalt" || r.status === "refunderet") && r.betalt_kl) {
    op(
      runde === 0 ? "betalt" : `betalt:${runde}`,
      "Tak – ekstra fragt er betalt",
      `Vi har fået din betaling på ${beloeb} for ekstra fragt. Fakturaen kommer under Min konto → Fakturaer. Betalingen er håndteret af vores betalingspartner Stripe.`,
    );
  }
  return ud;
}

async function sendOpgaver(admin: ReturnType<typeof createAdminClient>, opgaver: Opgave[]): Promise<number> {
  if (opgaver.length === 0) return 0;
  const sendt = new Set<string>();
  // Også "oprettet"-nøglerne (frafald nedenfor).
  const noegler = [...new Set(opgaver.flatMap((o) => [o.input.noegle, o.input.noegle.replace(/:[^:]+(:\d+)?$/, ":oprettet")]))];
  for (let i = 0; i < noegler.length; i += 200) {
    const { data, error } = await admin
      .from("notifikation_afsendelser")
      .select("noegle")
      .in("noegle", noegler.slice(i, i + 200));
    if (error) {
      console.error("Ekstra fragt: opslag af sendte beskeder fejlede:", error.message);
      return 0;
    }
    for (const r of data ?? []) sendt.add(r.noegle as string);
  }
  // Frafaldet, før sælgeren nogensinde fik regningen: ingen besked om et
  // frafald af noget, han aldrig har hørt om.
  const oprettetSendt = (noegle: string) => sendt.has(noegle.replace(/:frafaldet:\d+$/, ":oprettet"));
  let antal = 0;
  for (const o of opgaver) {
    if (sendt.has(o.input.noegle)) continue;
    if (/:frafaldet:\d+$/.test(o.input.noegle) && !oprettetSendt(o.input.noegle)) continue;
    // Påkrævet type: sendes, selv om nøglen ikke kan claimes af ukendt årsag.
    const r = await send(o.brugerId, "betalingsfrist", o.input, { springOverVedClaimFejl: true, altidMail: true });
    if (!r.dublet && !r.sprunget) antal++;
  }
  return antal;
}

export async function notificerEkstraFragt(): Promise<number> {
  try {
    const admin = createAdminClient();
    const nu = Date.now();
    const [nye, aabne] = await Promise.all([
      // Ændret inden for 48 timer: oprettet, afgjort, frafaldet, betalt.
      admin
        .from("ekstra_fragt_regninger")
        .select(FELTER)
        .gte("opdateret_kl", new Date(nu - 2 * DAG).toISOString())
        .order("opdateret_kl", { ascending: true })
        .limit(MAKS),
      // Påmindelse og spærring: afventer betaling, oprettet for 7+ dage siden
      // (eller genåbnet - så tæller genåbningen), og fristen er højst 90 dage
      // gammel.
      admin
        .from("ekstra_fragt_regninger")
        .select(FELTER)
        .eq("status", "afventer_betaling")
        .lte("oprettet_kl", new Date(nu - EKSTRA_FRAGT_PAAMIND_DAGE * DAG).toISOString())
        .gte("frist", new Date(nu - 90 * DAG).toISOString())
        .limit(MAKS),
    ]);
    for (const r of [nye, aabne]) {
      if (r.error) {
        // 42P01/PGRST205: migrationen er ikke kørt endnu.
        if (r.error.code !== "42P01" && r.error.code !== "PGRST205") {
          console.error("Ekstra fragt: beskeder kunne ikke hentes:", r.error.message);
        }
        return 0;
      }
    }
    const raekker = new Map<string, EkstraFragtBeskedRaekke>();
    for (const r of [...(nye.data ?? []), ...(aabne.data ?? [])] as unknown as EkstraFragtBeskedRaekke[]) raekker.set(r.id, r);
    const opgaver = [...raekker.values()].flatMap((r) => ekstraFragtBeskeder(r, nu));
    return await sendOpgaver(admin, opgaver);
  } catch (err) {
    console.error("Ekstra fragt: beskeder fejlede:", err);
    return 0;
  }
}
