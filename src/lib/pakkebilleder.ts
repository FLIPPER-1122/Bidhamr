// Pakkebilleder ved "Send pakke": fælles konstanter, typer og tekster for
// server actions og frontend. Ingen server-only-import.
// Reglerne er spejlet i supabase/migrations/20261003040000_pakkebilleder.sql
// (trade_marker_sendt, pakke_valider_billeder, storage-bucket 'pakke-billeder').
//
// Appen (Expo) kan bruge det samme direkte med supabase-js:
//   supabase.storage.from("pakke-billeder").upload(sti, fil, { upsert: false, contentType })
//       sti = <sælger-id>/<handel-id>/<uuid>.<endelse> (se sagBilledeSti i src/lib/sager.ts)
//   supabase.rpc("trade_marker_sendt", { p_trade, p_tracking, p_billeder: [{ sti, kategori }] })
//       -> { kode: "ok" } | { kode: <fejlkode> } (se PAKKE_SEND_FEJL)
//   supabase.from("pakke_billeder").select("id, trade_id, sti, kategori, oprettet_kl")
//   supabase.storage.from("pakke-billeder").createSignedUrls(stier, 3600)

export const PAKKE_BUCKET = "pakke-billeder";
export const PAKKE_MAKS_BILLEDER = 10;

export const PAKKE_BILLEDE_KATEGORIER = ["aaben_kasse", "lukket_kasse"] as const;
export type PakkeBilledeKategori = (typeof PAKKE_BILLEDE_KATEGORIER)[number];

export const PAKKE_KATEGORI_NAVN: Record<PakkeBilledeKategori, string> = {
  aaben_kasse: "Varen pakket i den åbne kasse",
  lukket_kasse: "Den lukkede kasse med label",
};

export function erPakkeBilledeKategori(v: unknown): v is PakkeBilledeKategori {
  return typeof v === "string" && (PAKKE_BILLEDE_KATEGORIER as readonly string[]).includes(v);
}

export type PakkeBilledeInput = { sti: string; kategori: PakkeBilledeKategori };

// Fejlkoder fra trade_marker_sendt -> dansk tekst til sælgeren.
export const PAKKE_SEND_FEJL: Record<string, string> = {
  ikke_logget_ind: "Du skal være logget ind.",
  ugyldigt_tracking: "Indtast et sporingsnummer (højst 100 tegn).",
  ikke_fundet: "Handlen findes ikke.",
  afhentning: "Varen skal hentes hos dig – der sendes ingen pakke.",
  allerede_sendt: "Pakken er allerede markeret som sendt.",
  billeder_kraeves:
    "Tag mindst ét billede af varen pakket i den åbne kasse og ét af den lukkede kasse med label.",
  ugyldige_billeder: "Et eller flere billeder er ugyldige. Tag dem igen.",
  billede_mangler: "Et billede blev ikke uploadet korrekt. Prøv igen.",
  for_mange_billeder: `Du kan højst tilføje ${PAKKE_MAKS_BILLEDER} billeder.`,
};
