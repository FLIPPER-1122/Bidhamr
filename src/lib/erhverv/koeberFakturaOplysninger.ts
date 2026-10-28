import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Købers oplysninger til firmaets faktura - ÉT sted.
//
// Reglen ligger i databasen (public.firma_faktura_koeber_auto i
// 20261102330000_firma_fakturaer.sql), fordi øjebliksbilledet bygges dér i
// samme transaktion som afsendelsen. Denne funktion er kodens eneste vej til
// den, så visninger og databasen aldrig er uenige.
//
// Rækkefølge (Filip, 27. okt. 2026 - "Oplysninger til fakturaen indsamles
// ved oprettelse"):
//   navn:    MitID (når køberen er verificeret) -> navnet til handlen ->
//            profilens navn
//   adresse: kontoens adresse (public.bruger_adresser, 20261102340000) ->
//            checkout (levering til døren) -> users.adresse (gammel fri tekst)
//   e-mail:  e-mailen til handlen -> kontoens e-mail
// Firmaets rettelser i kladden og købers egne firmanavn/CVR lægges
// ovenpå i public.firma_faktura_byg.
//
// Kun til serveren, og kun efter at kalderen har tjekket, at den indloggede
// er firmaet bag handlen eller køberen selv (købers persondata).

export type KoeberFakturaOplysninger = {
  navn: string | null;
  adresse: string | null;
  postnummer: string | null;
  by: string | null;
  email: string | null;
  firmanavn: string | null;
  cvr: string | null;
  navn_kilde: "mitid" | "konto";
  adresse_kilde: "konto" | "checkout" | "konto_fritekst" | "konto_ufuldstaendig" | null;
};

export async function hentKoeberFakturaOplysninger(tradeId: string): Promise<KoeberFakturaOplysninger | null> {
  const { data, error } = await createAdminClient().rpc("firma_faktura_koeber_auto", { p_trade: tradeId });
  if (error) throw error;
  return (data as KoeberFakturaOplysninger | null) ?? null;
}

export const ADRESSE_KILDE_TEKST: Record<NonNullable<KoeberFakturaOplysninger["adresse_kilde"]>, string> = {
  konto: "Adressen er købers egen adresse fra kontoen.",
  checkout: "Adressen er den, køberen gav ved betalingen.",
  konto_fritekst: "Adressen er fra købers profil.",
  konto_ufuldstaendig: "Købers adresse på kontoen er ikke fuldstændig. Tilføj postnummer og by.",
};
