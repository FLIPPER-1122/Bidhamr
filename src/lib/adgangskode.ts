// Krav til adgangskoder (ROADMAP-BESLUTNINGER.md, "Konto og GDPR").
// Bruges både i browseren (styrkemåler og krav, mens man skriver) og på
// serveren (signup, ny adgangskode, skift adgangskode). Serveren er det
// egentlige værn – browserens tjek er kun hjælp.
//
// Krav:
// - mindst 10 tegn (højst 72 – Supabase/bcrypt bruger kun de første 72 bytes)
// - ikke en af de mest almindelige adgangskoder
// - ikke mailadressen eller navnet
//
// Supabase-projektets egen indstilling (Auth -> Providers -> Email ->
// "Minimum password length") bør sættes til 10, så kravet også gælder appen.

export const MIN_LAENGDE = 10;
export const MAKS_LAENGDE = 72;

// De mest brugte adgangskoder (internationale lister + danske varianter).
// Sammenlignes uden store/små bogstaver og efter fjernelse af tal og tegn i
// enderne, så "Sommer2024!" fanges af "sommer".
const ALMINDELIGE = new Set([
  "123456", "1234567", "12345678", "123456789", "1234567890", "12345678910",
  "0123456789", "0987654321", "987654321", "111111", "1111111111", "000000",
  "0000000000", "123123", "123123123", "123321", "654321", "666666", "696969",
  "112233", "121212", "777777", "888888", "999999", "555555", "abc123",
  "password", "passw0rd", "password1", "password123", "passwort", "pass", "qwerty",
  "qwerty123", "qwertyuiop", "qwertyuiopå", "asdfgh", "asdfghjkl", "asdfghjklæø",
  "zxcvbnm", "zxcvbnm,.-", "azerty", "1q2w3e4r", "1q2w3e4r5t", "1qaz2wsx",
  "q1w2e3r4", "qazwsx", "iloveyou", "letmein", "welcome", "welcome1", "admin",
  "administrator", "login", "master", "monkey", "dragon", "football", "baseball",
  "soccer", "shadow", "sunshine", "princess", "superman", "batman", "starwars",
  "trustno1", "whatever", "freedom", "hello", "hejhej", "hejmeddig", "hemmelig",
  "hemmeligt", "kodeord", "adgangskode", "password!", "secret", "changeme",
  "default", "access", "computer", "internet", "samsung", "iphone", "google",
  "facebook", "instagram", "pokemon", "minecraft", "fortnite", "michael",
  "jennifer", "jordan", "charlie", "thomas", "daniel", "andreas", "mikkel",
  "frederik", "sofie", "emma", "freja", "mathias", "kasper", "jesper", "morten",
  "lars", "hansen", "jensen", "nielsen", "pedersen", "andersen", "larsen",
  "sommer", "vinter", "foraar", "forår", "efteraar", "efterår", "januar",
  "februar", "marts", "april", "juni", "juli", "august", "september", "oktober",
  "november", "december", "mandag", "fredag", "danmark", "denmark", "kobenhavn",
  "københavn", "copenhagen", "aarhus", "århus", "odense", "aalborg", "fcknhvn",
  "fckobenhavn", "brondby", "brøndby", "agf", "kanelsnegl", "hundehund",
  "kattekat", "elskerdig", "jegelskerdig", "mormor", "farfar", "bidhamr",
  "bidhamr.dk", "auktion", "auktioner", "dba", "tradera", "vinted",
  "abcdefghij", "abcdefgh", "aaaaaaaaaa", "lol123", "test", "test123",
  "testtest", "tester", "user", "bruger", "guest", "gaest", "gæst",
]);

// Normalisering til sammenligning: små bogstaver, uden tal/tegn i enderne.
function kerne(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFC")
    .replace(/^[^a-zæøå]+|[^a-zæøå]+$/g, "");
}

export function erAlmindelig(adgangskode: string): boolean {
  const lille = adgangskode.toLowerCase().normalize("NFC");
  if (ALMINDELIGE.has(lille)) return true;
  // Kun tal (fx et telefonnummer eller en dato) er altid for nemt.
  if (/^\d+$/.test(lille)) return true;
  // Ét tegn gentaget ("aaaaaaaaaa") eller to tegn på skift ("abababab").
  if (/^(.)\1+$/.test(lille) || /^(..)\1+$/.test(lille)) return true;
  const k = kerne(lille);
  if (k.length > 0 && ALMINDELIGE.has(k)) return true;
  // Gentaget almindeligt ord ("sommersommer").
  if (k.length % 2 === 0 && k.slice(0, k.length / 2) === k.slice(k.length / 2)) {
    if (ALMINDELIGE.has(k.slice(0, k.length / 2))) return true;
  }
  return false;
}

export type Personinfo = { email?: string | null; navn?: (string | null | undefined)[] };

// Dele af mail og navn, som ikke må udgøre adgangskoden. Kun dele på mindst
// 3 tegn, så korte navne som "Bo" ikke giver falske afvisninger.
function personDele(info: Personinfo): string[] {
  const dele: string[] = [];
  const email = (info.email ?? "").toLowerCase().trim();
  if (email) {
    dele.push(email);
    const lokal = email.split("@")[0] ?? "";
    dele.push(lokal, ...lokal.split(/[._+-]+/));
  }
  for (const n of info.navn ?? []) {
    const t = (n ?? "").toLowerCase().trim();
    if (!t) continue;
    dele.push(t.replace(/\s+/g, ""), ...t.split(/\s+/));
  }
  return [...new Set(dele.filter((d) => d.length >= 3))];
}

export function indeholderPersoninfo(adgangskode: string, info: Personinfo): boolean {
  const lille = adgangskode.toLowerCase();
  const k = kerne(lille);
  return personDele(info).some((d) => {
    // Hele koden er mailen/navnet (evt. med tal efter) ...
    if (lille === d || k === d) return true;
    // ... eller mailadressen/navnet fylder det meste af koden.
    return d.length >= 4 && lille.includes(d) && d.length >= lille.length * 0.6;
  });
}

export type Krav = {
  laengde: boolean;
  ikkeAlmindelig: boolean;
  ikkePersonlig: boolean;
};

export type Vurdering = {
  ok: boolean;
  krav: Krav;
  // 0 = meget svag ... 4 = stærk. Kun til styrkemåleren.
  styrke: 0 | 1 | 2 | 3 | 4;
  // Den første fejl, som kort tekst til brugeren. null når ok.
  fejl: string | null;
};

export const STYRKE_TEKST = ["Meget svag", "Svag", "Okay", "God", "Stærk"] as const;

export function vurderAdgangskode(adgangskode: string, info: Personinfo = {}): Vurdering {
  const pw = typeof adgangskode === "string" ? adgangskode : "";
  const krav: Krav = {
    laengde: pw.length >= MIN_LAENGDE && pw.length <= MAKS_LAENGDE,
    ikkeAlmindelig: pw.length > 0 && !erAlmindelig(pw),
    ikkePersonlig: pw.length > 0 && !indeholderPersoninfo(pw, info),
  };

  let fejl: string | null = null;
  if (pw.length < MIN_LAENGDE) fejl = `Adgangskoden skal være mindst ${MIN_LAENGDE} tegn.`;
  else if (pw.length > MAKS_LAENGDE) fejl = `Adgangskoden må højst være ${MAKS_LAENGDE} tegn.`;
  else if (!krav.ikkeAlmindelig) fejl = "Adgangskoden er for almindelig. Vælg noget, der er svært at gætte.";
  else if (!krav.ikkePersonlig) fejl = "Adgangskoden må ikke være din e-mail eller dit navn.";

  // Styrke: længde + variation af tegntyper. Svag, hvis et krav fejler.
  const typer =
    Number(/[a-zæøå]/.test(pw)) +
    Number(/[A-ZÆØÅ]/.test(pw)) +
    Number(/\d/.test(pw)) +
    Number(/[^A-Za-z0-9æøåÆØÅ]/.test(pw));
  const unikke = new Set(pw).size;
  let point = 0;
  if (pw.length >= 8) point++;
  if (pw.length >= MIN_LAENGDE) point++;
  if (pw.length >= 14) point++;
  if (pw.length >= 18) point++;
  if (typer >= 3) point++;
  if (unikke < 5) point -= 2;
  let styrke = Math.max(0, Math.min(4, point)) as Vurdering["styrke"];
  if (fejl) styrke = Math.min(styrke, 1) as Vurdering["styrke"];
  if (!pw) styrke = 0;

  return { ok: fejl === null, krav, styrke, fejl };
}
