// Gemte søgninger (tabellen gemte_soegninger, migration
// 20261007010000_brugerens_egne_ting.sql). Fælles for siden /auktioner, listen
// under Min konto og notifikations-cron'en. Ingen server-only-import.

export const MAKS_GEMTE_SOEGNINGER = 20;
export const MAKS_NAVN = 60;
export const MAKS_SOEGEORD = 100;

// Søgekriterierne - samme felter som filtrene på /auktioner.
export type SoegeKriterier = {
  soegeord: string;
  kategori: string | null;
  postnummer: string | null;
  radiusKm: number | null;
};

export type GemtSoegning = SoegeKriterier & {
  id: string;
  navn: string;
  besked: boolean;
  oprettetKl: string;
};

// Linket, der åbner søgningen igen på /auktioner (også fra notifikationen).
// Nyeste først, så de nye auktioner står øverst.
export function soegningHref(k: SoegeKriterier, nyesteFoerst = false): string {
  const p = new URLSearchParams();
  if (k.soegeord) p.set("q", k.soegeord);
  if (k.kategori) p.set("kategori", k.kategori);
  if (k.postnummer) {
    p.set("postnummer", k.postnummer);
    if (k.radiusKm) p.set("afstand", String(k.radiusKm));
  }
  if (nyesteFoerst) p.set("sortering", "nyeste");
  const qs = p.toString();
  return qs ? `/auktioner?${qs}` : "/auktioner";
}

// Kort beskrivelse af filtrene, fx "Ure · inden for 50 km af 8000".
export function kriterieTekst(k: SoegeKriterier): string {
  const dele: string[] = [];
  if (k.soegeord) dele.push(`"${k.soegeord}"`);
  if (k.kategori) dele.push(k.kategori);
  if (k.postnummer) {
    dele.push(k.radiusKm ? `inden for ${k.radiusKm} km af ${k.postnummer}` : `nær ${k.postnummer}`);
  }
  return dele.join(" · ");
}

// Forslag til navn, når søgningen gemmes.
export function standardNavn(k: SoegeKriterier): string {
  const navn = k.soegeord || k.kategori || "Min søgning";
  return navn.slice(0, MAKS_NAVN);
}
