// Ekstra fragt ved for lille pakkestørrelse (Filip, 21. okt. 2026; migration
// 20261029020000_ekstra_fragt.sql). Fælles for server og klient: fejlkoden
// for spærringen, statusnavne, frister og beløbsparsing. Ingen server-only.

// Databasens fejl, når sælgeren er spærret, fordi en ekstraregning ikke er
// betalt efter fristen (ekstra_fragt_kraev - nye auktioner, "sæt op igen" og
// "tilbud til næste byder").
export const EKSTRA_FRAGT_FEJLKODE = "BHX01";

export const EKSTRA_FRAGT_SPAERRET_TEKST =
  "Fristen for at betale ekstra fragt er overskredet. Indtil regningen er betalt, kan du ikke oprette nye auktioner, sætte en vare op igen eller tilbyde en vare til næste byder. Du betaler på handlen under Mine handler. Dine aktive auktioner og handler fortsætter som normalt.";

export function erEkstraFragtFejl(code: string | null | undefined, message?: string | null): boolean {
  return code === EKSTRA_FRAGT_FEJLKODE || (message ?? "").includes("ekstra_fragt_ubetalt");
}

// Frister (samme tal som databasen).
export const EKSTRA_FRAGT_FRIST_DAGE = 14;
export const EKSTRA_FRAGT_PAAMIND_DAGE = 7;
// Fastholdes en indsigelse, er fristen mindst så mange dage fra afgørelsen.
export const EKSTRA_FRAGT_FASTHOLDT_MIN_DAGE = 7;

export type EkstraFragtStatus = "afventer_betaling" | "behandles" | "betalt" | "indsigelse" | "frafaldet" | "refunderet";

export const EKSTRA_FRAGT_STATUS_NAVN: Record<EkstraFragtStatus, string> = {
  afventer_betaling: "Afventer betaling",
  behandles: "Betalingen behandles",
  betalt: "Betalt",
  indsigelse: "Indsigelse – BidHamr ser på den",
  frafaldet: "Frafaldet",
  refunderet: "Refunderet",
};

export type MaaltStoerrelse = "lille" | "mellem" | "stor" | "over_stor";

export const STOERRELSE_NAVN: Record<string, string> = {
  lille: "Lille (op til 1 kg)",
  mellem: "Mellem (op til 5 kg)",
  stor: "Stor (op til 15 kg)",
  over_stor: "Over 15 kg",
};

export function erMaaltStoerrelse(v: unknown): v is MaaltStoerrelse {
  return v === "lille" || v === "mellem" || v === "stor" || v === "over_stor";
}

// Kroner (dansk format, fx "1.250,50" eller "35") til øre - kun heltal, ingen
// kommatal-regning. null = ugyldigt.
export function kronerTilOere(v: string): number | null {
  const ren = String(v ?? "").trim().replace(/\s|kr\.?/gi, "");
  if (!ren) return null;
  let heltal: string;
  let decimaler = "";
  if (ren.includes(",")) {
    // Dansk: punktum som tusindtalsskilletegn, komma som decimal.
    const [h, d, ...rest] = ren.split(",");
    if (rest.length > 0) return null;
    heltal = h.replace(/\./g, "");
    decimaler = d ?? "";
  } else if (/^\d{1,3}(\.\d{3})+$/.test(ren)) {
    heltal = ren.replace(/\./g, "");
  } else {
    const [h, d, ...rest] = ren.split(".");
    if (rest.length > 0) return null;
    heltal = h;
    decimaler = d ?? "";
  }
  if (!/^\d{1,7}$/.test(heltal) || !/^\d{0,2}$/.test(decimaler)) return null;
  const oere = Number(heltal) * 100 + Number((decimaler + "00").slice(0, 2));
  return Number.isSafeInteger(oere) && oere > 0 ? oere : null;
}

// Vægt i kg (dansk, fx "7,2") til gram - heltal. null = ugyldigt.
export function kgTilGram(v: string): number | null {
  const ren = String(v ?? "").trim().replace(/\s|kg/gi, "").replace(",", ".");
  if (!/^\d{1,4}(\.\d{1,3})?$/.test(ren)) return null;
  const [h, d = ""] = ren.split(".");
  const gram = Number(h) * 1000 + Number((d + "000").slice(0, 3));
  return gram >= 1 && gram <= 1_000_000 ? gram : null;
}

// Fejlkoder fra databasen -> dansk tekst (staff).
export const EKSTRA_FRAGT_STAFF_FEJL: Record<string, string> = {
  ingen_adgang: "Du har ikke adgang. Log ind i admin med to-trins-login, og prøv igen.",
  ikke_fundet: "Forsendelsen eller regningen findes ikke. Genindlæs siden.",
  inhabil: "Du er inhabil: du er part i handlen eller har handlet med en af parterne. Lad en kollega tage den.",
  ikke_udgaaende: "Ekstra fragt kan kun opkræves for sælgerens udgående pakke.",
  ikke_sendt: "Pakken er ikke sendt (labelen blev aldrig lavet).",
  afhentning: "Varen blev afhentet – der er ingen fragt at opkræve.",
  ingen_betaling: "Handlen er ikke betalt, så regningen kan ikke knyttes til den.",
  ugyldigt_beloeb: "Beløbet skal være mellem 3,00 kr. og 10.000,00 kr.",
  maaling_mangler: "Skriv fragtfirmaets måling: størrelse eller vægt.",
  ugyldig_stoerrelse: "Vælg den målte størrelse.",
  ugyldig_vaegt: "Vægten er ugyldig.",
  fakturanummer_mangler: "Skriv fragtfirmaets fakturanummer.",
  for_lang_tekst: "Teksten er for lang. Gør den kortere.",
  dokumentation_mangler: "Upload fragtfirmaets faktura (PDF eller billede) igen.",
  findes_allerede: "Der er allerede en åben ekstraregning på denne pakke.",
  faktura_brugt: "Denne faktura fra fragtfirmaet er allerede opkrævet for pakken.",
  grund_mangler: "Skriv en begrundelse. Den vises for sælgeren.",
  begrundelse_mangler: "Skriv en begrundelse. Den vises for sælgeren.",
  ugyldigt_udfald: "Vælg frafald eller fasthold.",
  behandles: "Sælgerens betaling behandles lige nu. Prøv igen om lidt.",
  forkert_status: "Regningen har ændret status. Genindlæs siden.",
  ingen_tabt_bankindsigelse: "Regningen kan kun genåbnes, når betalingen er tilbageført efter en tabt bankindsigelse.",
  delvis_bankindsigelse: "Bankindsigelsen gælder kun en del af beløbet – håndtér den manuelt.",
};

// Genåbnes en regning efter en tabt bankindsigelse, har sælgeren så mange dage.
export const EKSTRA_FRAGT_GENAABNET_FRIST_DAGE = 14;

// Fejlkoder fra databasen -> dansk tekst (sælgeren).
export const EKSTRA_FRAGT_SAELGER_FEJL: Record<string, string> = {
  ingen_adgang: "Log ind, og prøv igen.",
  ikke_fundet: "Vi kan ikke finde regningen. Genindlæs siden, og prøv igen.",
  tekst_mangler: "Skriv, hvorfor du mener, at målingen er forkert.",
  for_kort: "Skriv lidt mere om, hvorfor du mener, at målingen er forkert.",
  for_lang_tekst: "Teksten er for lang. Gør den kortere, og prøv igen.",
  allerede_indsigelse: "Du har allerede gjort indsigelse mod denne regning.",
  behandles: "Din betaling behandles lige nu. Vent lidt, og genindlæs siden.",
  forkert_status: "Regningen er ændret i mellemtiden. Genindlæs siden for at se, hvordan den står nu.",
  betalt: "Regningen er allerede betalt.",
  indsigelse: "Vi ser på din indsigelse. Du skal ikke betale, før vi har afgjort den.",
  frafaldet: "Regningen er frafaldet. Du skal ikke betale.",
  refunderet: "Regningen er refunderet. Du skal ikke betale.",
};
