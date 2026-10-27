// Eksempler til kontaktoplysninger i auktioner (auktionKontaktGrund i
// src/lib/auktionKontaktinfo.ts og public.auktion_kontaktinfo_grund i
// databasen). PRÆCIS samme liste står i testblokken sidst i
// supabase/migrations/20261102130000_beskrivelse_kontaktinfo.sql - ændres en
// regel, SKAL begge steder rettes.
//
// [tekst, svar for en privat sælger, svar for et firma]
export type AuktionKontaktEksempel = [tekst: string, privat: string | null, firma: string | null];

export const AUKTION_KONTAKT_EKSEMPLER: AuktionKontaktEksempel[] = [
  // Kontaktoplysninger - stoppes for alle.
  ["Ring på 22 33 44 55 for mere info", "telefon", "telefon"],
  ["Spørgsmål? 22334455", "telefon", "telefon"],
  ["Tlf. +45 2233 4455", "telefon", "telefon"],
  ["Skriv til hans@gmail.com", "email", "email"],
  ["Kontakt info@firma.dk", "email", "email"],
  ["Betal med MobilePay 22334455", "mobilepay", "mobilepay"],
  ["MobilePay 22334455", "mobilepay", "mobilepay"],
  ["Overfør til reg 1234 konto 12345678", "bank", "bank"],
  ["Skriv på snap @hans_123", "socialt_medie", "socialt_medie"],
  // Links - stoppes for private, må gerne stå for firmaer.
  ["Se flere billeder på www.dba.dk", "link", null],
  ["Læs mere på https://firma.dk/sofaer/model-x", "link", null],
  ["Producentens side: firma.com", "link", null],
  // Et link fjerner ikke resten.
  ["Se www.firma.dk eller ring 22 33 44 55", "link", "telefon"],
  ["Se www.firma.dk - MobilePay 22334455", "link", "mobilepay"],
  ["www.firma.dk / salg@firma.dk", "email", "email"],
  // Almindelige beskrivelser - slipper igennem.
  ["Sofa i grå uld. Mål: 200 x 90 x 45 cm. Nypris 4.500 kr, sælges for 1.200 kr.", null, null],
  ["Købt 12.03.2024, brugt ca. 10 gange. Afhentes efter 24/12.", null, null],
  ["Cykel 28 tommer, 7 gear, årgang 2019. Stelnummer WAW12345678.", null, null],
  ["iPhone 13, 128 GB, sort. Batteri 87 %. IMEI 356938035643809", null, null],
  ["Lego 42115, komplet med vejledning og æske", null, null],
  ["Børnetøj str 86 92 98 104, 10 dele", null, null],
  ["Kan sendes med GLS eller afhentes i 8000 Aarhus C", null, null],
  ["Fra 2019/2020. Pris 2.500-3.000 ved nypris.", null, null],
];
