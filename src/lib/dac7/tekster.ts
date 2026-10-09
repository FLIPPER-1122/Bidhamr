// Tekster til DAC7 (skatteoplysninger). Ingen server-only - bruges også i
// klientkomponenter. Se docs/DAC7.md.

import { FRIST_DAGE, GRAENSE_ANTAL, GRAENSE_EUR, indberetningsfrist } from "@/lib/dac7/regler";

export const DAC7 = {
  sideTitel: "Skatteoplysninger",
  sideIntro:
    "Som markedsplads skal BidHamr fortælle Skattestyrelsen om sælgere, der i løbet af et år har mindst 30 salg eller sælger for over 2.000 euro. Det hedder DAC7 og gælder alle markedspladser i EU.",
  hvorforTitel: "Hvorfor skal I bruge mine oplysninger?",
  hvorforTekst:
    "Reglerne kræver, at vi indberetter navn, adresse, fødselsdato, CPR-nummer, antal salg og hvor meget du har fået for dem – én gang om året, senest 31. januar året efter. Du får altid en kopi her af det, vi har indberettet. Det betyder ikke i sig selv, at du skal betale skat – det afhænger af, om du har tjent penge på salget. Spørg Skattestyrelsen, hvis du er i tvivl.",
  frist: (aar: number) => `Indberetningen for ${aar} sendes senest ${indberetningsfrist(aar)}.`,
  statusTitel: (aar: number) => `Dine salg i ${aar}`,
  graenseTekst: `Grænsen er ${GRAENSE_ANTAL} salg eller ${GRAENSE_EUR.toLocaleString("da-DK")} euro (ca. {kr}) i et kalenderår.`,
  ikkeNaer: "Du er langt fra grænsen. Vi beder dig først om oplysningerne, hvis du nærmer dig den.",
  naer: "Du nærmer dig grænsen. Udfyld dine oplysninger herunder, så vi kan indberette korrekt.",
  pligtig: "Du har nået grænsen, og dine salg i år skal indberettes til Skattestyrelsen.",
  anmodningFrist: (frist: string) => `Vi mangler dine oplysninger. Udfyld dem senest ${frist}.`,
  spaerret:
    "Du kan ikke sætte nye varer til salg, før du har udfyldt dine oplysninger. Dine igangværende auktioner og handler fortsætter som normalt.",
  komplet: "Tak – vi har de oplysninger, vi skal bruge.",
  erhverv:
    "Din firmakonto indberettes med firmaets navn, CVR-nummer og adresse, som vi allerede har. Er de forkerte, så skriv til erhverv@bidhamr.dk.",
  mitidMangler: "Bekræft dig med MitID først – så får vi dit navn og din fødselsdato derfra.",

  formTitel: "Dine oplysninger",
  formIntro:
    "Navn og fødselsdato kommer fra dit MitID. Adressen skal være din bopæl (folkeregisteradresse).",
  navn: "Navn (fra MitID)",
  foedselsdato: "Fødselsdato (fra MitID)",
  adresse: "Vej og husnummer",
  adresseHjaelp: "Fx Nørregade 12, 2. th.",
  postnummer: "Postnummer",
  bynavn: "By",
  cpr: "CPR-nummer",
  cprHjaelp:
    "Skattestyrelsen bruger CPR-nummeret som dit skatte-id. Vi gemmer det krypteret, og kun du og BidHamrs ledelse kan se det.",
  cprGemt: (maske: string) => `Gemt: ${maske}. Udfyld kun feltet, hvis du vil rette det.`,
  andetTinSpm: "Har du også et skatte-id fra et andet EU-land?",
  andetTinLand: "Land",
  andetTinNummer: "Skatte-id i det land",
  andetTinFjern: "Fjern",
  bopaelDk: "Jeg bor i Danmark (min folkeregisteradresse er i Danmark).",
  bekraeft: "Jeg bekræfter, at oplysningerne er rigtige.",
  gem: "Gem oplysninger",
  gemmer: "Gemmer …",
  gemt: "Tak – dine oplysninger er gemt.",

  kopiTitel: "Det har vi indberettet",
  kopiIntro: "En kopi af det, BidHamr har indberettet om dig til Skattestyrelsen.",
  kopiIngen: "Vi har ikke indberettet noget om dig endnu.",
  kopiAar: (aar: number) => `Indkomståret ${aar}`,
  kvartal: (n: number) => `${n}. kvartal`,
  antalSalg: "Antal salg",
  vederlag: "Du har fået (efter gebyr)",
  gebyr: "Gebyr til BidHamr",
  vederlagForklaring: "Beløbet er det, du fik for varerne, efter at BidHamrs sælgergebyr er trukket fra.",

  fejl: {
    generisk: "Noget gik galt. Prøv igen om lidt.",
    ikkeLoggetInd: "Du er ikke logget ind længere. Log ind igen.",
    adresse: "Skriv vej og husnummer (kun bogstaver, tal og almindelig tegnsætning).",
    postnummer: "Skriv et postnummer med 4 cifre.",
    bynavn: "Skriv bynavnet.",
    cpr: "Skriv dit CPR-nummer med 10 cifre (fx 010190-1234).",
    cprFoedselsdato: "CPR-nummeret passer ikke med fødselsdatoen fra dit MitID. Tjek, at du har skrevet det rigtigt.",
    cprMangler: "Skriv dit CPR-nummer.",
    andetTin: "Vælg landet, og skriv skatte-id'et (4–30 tegn).",
    bekraeft: "Sæt flueben for at bekræfte, at oplysningerne er rigtige.",
    mitid: "Bekræft dig med MitID først.",
    erhverv: "Firmakonti skal ikke udfylde dette – vi bruger firmaets CVR-nummer.",
    udland:
      "Vi kan kun indberette sælgere med bopæl i Danmark. Bor du i udlandet, så skriv til support@bidhamr.dk, så finder vi en løsning.",
    ikkeTilgaengelig: "Vi kan ikke gemme skatteoplysninger lige nu. Prøv igen senere.",
    forMange: "Du har prøvet for mange gange. Vent lidt, og prøv så igen.",
  },

  // Notifikationer (type 'skat', påkrævet).
  besked: {
    anmodning: (frist: string) => ({
      titel: "Vi mangler dine skatteoplysninger",
      tekst: `Du nærmer dig grænsen for, hvornår BidHamr skal indberette dine salg til Skattestyrelsen (DAC7). Udfyld dine oplysninger under Min konto → Skatteoplysninger senest ${frist}.`,
    }),
    paamindelse: (nr: 1 | 2, frist: string) => ({
      titel: nr === 1 ? "Påmindelse: dine skatteoplysninger" : "Sidste påmindelse: dine skatteoplysninger",
      tekst: `Vi mangler stadig dine oplysninger til Skattestyrelsen (DAC7). Udfyld dem under Min konto → Skatteoplysninger senest ${frist}. Ellers kan du ikke sætte nye varer til salg, før de er udfyldt.`,
    }),
    spaerret: {
      titel: "Du kan ikke sætte nye varer til salg",
      tekst: `Fristen på ${FRIST_DAGE} dage er overskredet, og vi mangler stadig dine oplysninger til Skattestyrelsen (DAC7). Du kan sætte varer til salg igen, så snart du har udfyldt dem under Min konto → Skatteoplysninger. Dine igangværende auktioner og handler fortsætter som normalt.`,
    },
    indberettet: (aar: number) => ({
      titel: `Vi har indberettet dine salg for ${aar}`,
      tekst: `BidHamr har indberettet dine salg i ${aar} til Skattestyrelsen, sådan som reglerne (DAC7) kræver. Du kan se en kopi af det indberettede under Min konto → Skatteoplysninger.`,
    }),
  },
} as const;
