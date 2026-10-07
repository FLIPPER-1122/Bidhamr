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
