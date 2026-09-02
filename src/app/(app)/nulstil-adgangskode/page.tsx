import { redirect } from "next/navigation";

// Gammel sti. Nulstillingsmails sendt før omlægningen til /auth/callback peger
// stadig herhen, så ruten bevares som viderestilling. Hash-fragmentet med
// tokenet følger ikke med en server-redirect, så vi sender brugeren videre via
// klienten på målsiden i stedet for at tabe sessionen.
export default function NulstilAdgangskodeGammelSti() {
  redirect("/reset-password");
}
