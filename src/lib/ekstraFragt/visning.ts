// Visning af ekstra fragt (for lille pakkestørrelse) - fælles for sælgerens
// kort, mærker, bjælker og admin. Kun formatering, ingen regler: status,
// frist og spærring kommer fra databasen. Ingen server-only.
import { PAKKESTOERRELSE_NAVN, type Pakkestoerrelse } from "@/lib/fragt/types";
import { STOERRELSE_NAVN, type EkstraFragtStatus } from "@/lib/ekstraFragt/tekster";

// Regninger, sælgeren skal gøre noget ved (eller vente på).
export const EKSTRA_FRAGT_AABNE: readonly EkstraFragtStatus[] = ["afventer_betaling", "behandles", "indsigelse"];

export function erAabenEkstraFragt(status: string): boolean {
  return (EKSTRA_FRAGT_AABNE as readonly string[]).includes(status);
}

// Returfragt i en sag (ekstra_fragt_regninger.slags 'returfragt_sag',
// 20261102210000): sælgeren betaler returfragten ved en transportskade med
// dårlig indpakning. Den har aldrig en måling (en regning for for lille
// pakkestørrelse har altid målt størrelse eller vægt) - så den kan kendes
// uden ekstra felter fra databasen.
export function erReturfragtRegning(r: {
  slags?: string | null;
  maalt_stoerrelse: string | null;
  maalt_vaegt_gram: number | null;
}): boolean {
  if (r.slags) return r.slags === "returfragt_sag";
  return !r.maalt_stoerrelse && r.maalt_vaegt_gram == null;
}

// Sælgerens valgte størrelse ("lille", "mellem", "stor").
export function valgtStoerrelseNavn(v: string | null | undefined): string {
  if (!v) return "–";
  return PAKKESTOERRELSE_NAVN[v as Pakkestoerrelse] ?? v;
}

// Fragtfirmaets måling som én kort tekst, fx "Stor (op til 15 kg), 7,2 kg, 60 x 40 x 30 cm".
export function maalingTekst(r: {
  maalt_stoerrelse: string | null;
  maalt_vaegt_gram: number | null;
  maalt_maal: string | null;
}): string {
  const dele: string[] = [];
  if (r.maalt_stoerrelse) dele.push(STOERRELSE_NAVN[r.maalt_stoerrelse] ?? r.maalt_stoerrelse);
  if (r.maalt_vaegt_gram != null) dele.push(vaegtTekst(r.maalt_vaegt_gram));
  if (r.maalt_maal) dele.push(r.maalt_maal);
  return dele.join(", ") || "–";
}

export function vaegtTekst(gram: number): string {
  return `${(gram / 1000).toLocaleString("da-DK", { maximumFractionDigits: 3 })} kg`;
}

const TZ = "Europe/Copenhagen";

// "4. november 2026"
export function ekstraFragtDato(iso: string | null | undefined): string {
  if (!iso) return "–";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "–";
  return new Date(t).toLocaleDateString("da-DK", { day: "numeric", month: "long", year: "numeric", timeZone: TZ });
}

// "4. nov. 2026 14.05"
export function ekstraFragtTid(iso: string | null | undefined): string {
  if (!iso) return "–";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "–";
  return new Date(t).toLocaleString("da-DK", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });
}

// Link direkte til regningen på handelssiden. betal=true åbner betalingen
// med det samme (færrest klik fra bjælken/mærket).
export function ekstraFragtHref(tradeId: string, opts: { firma?: boolean; betal?: boolean } = {}): string {
  const basis = opts.firma ? "/firma/salg" : "/mine-handler";
  return `${basis}/${encodeURIComponent(tradeId)}${opts.betal ? "?ekstrafragt=betal" : ""}#ekstra-fragt`;
}
