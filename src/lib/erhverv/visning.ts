// Visning af erhvervsdata (datoer og beløb) - fælles for Firma oversigt og
// opret auktion. Ren formatering, ingen data.
import type { Ugekvote } from "@/lib/erhverv/regler";

const TZ = "Europe/Copenhagen";

// "mandag den 13. oktober"
export function ugedagDato(iso: string): string {
  const d = new Date(iso);
  const ugedag = d.toLocaleDateString("da-DK", { timeZone: TZ, weekday: "long" });
  const dato = d.toLocaleDateString("da-DK", { timeZone: TZ, day: "numeric", month: "long" });
  return `${ugedag} den ${dato}`;
}

// Danske numre vises pænt: "11223344", "+4511223344", "0045 11 22 33 44"
// -> "+45 11 22 33 44". Andre numre (udenlandske) vises som de er skrevet.
export function visTelefon(telefon: string | null | undefined): string {
  if (!telefon) return "";
  const cifre = telefon.replace(/[^0-9]/g, "");
  const lokal =
    cifre.length === 8 && !telefon.trim().startsWith("+")
      ? cifre
      : cifre.length === 10 && cifre.startsWith("45") && telefon.trim().startsWith("+")
        ? cifre.slice(2)
        : cifre.length === 12 && cifre.startsWith("0045")
          ? cifre.slice(4)
          : null;
  if (!lokal) return telefon.trim();
  return `+45 ${lokal.replace(/(\d{2})(?=\d)/g, "$1 ")}`;
}

// Til tel:-links: kun + og cifre.
export function telefonLink(telefon: string): string {
  return `tel:${telefon.replace(/[^0-9+]/g, "")}`;
}

// "13. oktober 2026"
export function langDato(iso: string): string {
  return new Date(iso).toLocaleDateString("da-DK", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" });
}

// Hvornår kan næste auktion oprettes, når ugens auktioner er brugt?
// (erhverv_kvote: naeste_ledige er nu, når der er plads, ellers næste mandag.)
export function naesteLedigeTekst(k: Ugekvote): string {
  return ugedagDato(k.brugt < k.max && k.naeste_ledige ? k.naeste_ledige : k.naeste_uge);
}

// Hele kroner -> "1.250 kr."
export function kr(beloeb: number): string {
  return `${Math.round(beloeb).toLocaleString("da-DK")} kr.`;
}

// Øre -> "1.250,50 kr."
export function krFraOere(oere: number): string {
  return `${(oere / 100).toLocaleString("da-DK", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} kr.`;
}
