// DAC7-regler, der bruges både på serveren og i klientkomponenter (ingen
// hemmeligheder her). Grænserne står også i databasen
// (supabase/migrations/20261014010000_dac7.sql, dac7_saelgertal) - ret begge
// steder. Se docs/DAC7.md.

// Indberetningspligtig: mindst 30 salg ELLER over 2.000 EUR i et kalenderår.
export const GRAENSE_ANTAL = 30;
export const GRAENSE_EUR = 2000;
// Vi beder om oplysningerne, når sælgeren nærmer sig: 25 salg eller 1.500 EUR.
export const VARSEL_ANTAL = 25;
export const VARSEL_EUR = 1500;
// Frist fra første anmodning, og hvornår der sendes påmindelser.
export const FRIST_DAGE = 60;

// Fristen for indberetning til Skattestyrelsen: 31. januar året efter.
export function indberetningsfrist(aar: number): string {
  return `31. januar ${aar + 1}`;
}

// CPR: 10 cifre, evt. med bindestreg efter de første 6. Returnerer de 10
// cifre eller null.
export function normaliserCpr(input: string): string | null {
  const ren = input.replace(/[\s-]/g, "");
  return /^[0-9]{10}$/.test(ren) ? ren : null;
}

// De første 6 cifre i CPR-nummeret skal være fødselsdatoen fra MitID (DDMMÅÅ).
// foedselsdato er "ÅÅÅÅ-MM-DD".
export function cprPasserMedFoedselsdato(cpr: string, foedselsdato: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(foedselsdato);
  if (!m) return false;
  return cpr.slice(0, 6) === `${m[3]}${m[2]}${m[1].slice(2)}`;
}

// Viser kun fødselsdato-delen: "010190-••••".
export function maskerCpr(cpr: string | null): string | null {
  if (!cpr || !/^[0-9]{10}$/.test(cpr)) return null;
  return `${cpr.slice(0, 6)}-••••`;
}

// Udenlandsk skatte-id: bogstaver og tal, evt. med mellemrum, bindestreg,
// punktum eller skråstreg - 4 til 30 tegn.
export function normaliserTin(input: string): string | null {
  const ren = input.trim().replace(/\s+/g, " ").toUpperCase();
  return /^[A-Z0-9][A-Z0-9 ./-]{2,28}[A-Z0-9]$/.test(ren) ? ren : null;
}

// EU-lande (ISO 3166-1 alpha-2) til "skatte-id fra et andet EU-land".
export const EU_LANDE: { kode: string; navn: string }[] = [
  { kode: "AT", navn: "Østrig" },
  { kode: "BE", navn: "Belgien" },
  { kode: "BG", navn: "Bulgarien" },
  { kode: "CY", navn: "Cypern" },
  { kode: "CZ", navn: "Tjekkiet" },
  { kode: "DE", navn: "Tyskland" },
  { kode: "EE", navn: "Estland" },
  { kode: "ES", navn: "Spanien" },
  { kode: "FI", navn: "Finland" },
  { kode: "FR", navn: "Frankrig" },
  { kode: "GR", navn: "Grækenland" },
  { kode: "HR", navn: "Kroatien" },
  { kode: "HU", navn: "Ungarn" },
  { kode: "IE", navn: "Irland" },
  { kode: "IT", navn: "Italien" },
  { kode: "LT", navn: "Litauen" },
  { kode: "LU", navn: "Luxembourg" },
  { kode: "LV", navn: "Letland" },
  { kode: "MT", navn: "Malta" },
  { kode: "NL", navn: "Holland" },
  { kode: "PL", navn: "Polen" },
  { kode: "PT", navn: "Portugal" },
  { kode: "RO", navn: "Rumænien" },
  { kode: "SE", navn: "Sverige" },
  { kode: "SI", navn: "Slovenien" },
  { kode: "SK", navn: "Slovakiet" },
];

export function erEuLand(kode: string): boolean {
  return EU_LANDE.some((l) => l.kode === kode);
}

// Adresse: almindelige bogstaver, tal og tegnsætning - ingen tegn, der kan
// tolkes som en formel, når chefen åbner filen i et regneark.
const ADRESSE_TEGN = /^[\p{L}\p{M}0-9 .,'/\-]+$/u;

export function gyldigAdresse(s: string): boolean {
  const t = s.trim();
  return t.length >= 3 && t.length <= 200 && ADRESSE_TEGN.test(t) && /^[\p{L}0-9]/u.test(t);
}

export function gyldigBynavn(s: string): boolean {
  const t = s.trim();
  return t.length >= 1 && t.length <= 100 && ADRESSE_TEGN.test(t) && /^[\p{L}0-9]/u.test(t);
}

export function gyldigPostnummer(s: string): boolean {
  return /^[0-9]{4}$/.test(s.trim());
}

// Kroner med 2 decimaler (fra øre).
export function kr(oere: number): string {
  return (
    (Number(oere) / 100).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr."
  );
}

// Delt juridisk navn fra MitID: alt undtagen sidste ord er fornavn(e).
export function delNavn(navn: string): { fornavn: string; efternavn: string } {
  const dele = navn.trim().split(/\s+/).filter(Boolean);
  if (dele.length === 0) return { fornavn: "UKENDT", efternavn: "UKENDT" };
  if (dele.length === 1) return { fornavn: dele[0], efternavn: dele[0] };
  return { fornavn: dele.slice(0, -1).join(" "), efternavn: dele[dele.length - 1] };
}
