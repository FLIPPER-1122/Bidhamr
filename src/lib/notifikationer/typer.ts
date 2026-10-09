// Notifikationstyper - ét sted for hele hjemmesiden (og som reference for appen).
// Påkrævet-listen er spejlet i SQL (notifikation_paakraevet / notifikation_kendt_type
// i supabase/migrations/20261002060000_notifikationer.sql; 'spoergsmaal' tilføjet i
// 20261006040000_auktionsfunktioner.sql; 'gemt_soegning' i
// 20261007010000_brugerens_egne_ting.sql; 'bedoemmelse' i
// 20261007020000_bedoemmelse_svar.sql; 'afgoerelse' (påkrævet) i
// 20261009010000_dsa.sql; 'auktion_status' i
// 20261009040000_skjult_auktion_pause.sql; 'pakke_indleveret' (påkrævet) i
// 20261012010000_fragt_dao_shipmondo.sql). Ændres listen her,
// skal SQL'en også rettes i en ny migration.
//
// Ingen server-only-import: frontend må gerne bruge navne og beskrivelser.

export type NotifikationType =
  | "vundet"
  | "betalingsfrist"
  | "betaling_modtaget"
  | "pakke_sendt"
  | "pakke_indleveret"
  | "pakke_leveret"
  | "udbetaling"
  | "sag"
  | "advarsel"
  | "andenchance"
  | "overbudt"
  | "bud_paa_egen"
  | "like"
  | "fulgt_slutter_snart"
  | "ny_auktion_fulgt_saelger"
  | "ny_besked"
  | "spoergsmaal"
  | "gemt_soegning"
  | "bedoemmelse"
  | "afgoerelse"
  | "auktion_status";

export type Kanal = "klokke" | "mail" | "push";

export type NotifikationTypeInfo = {
  type: NotifikationType;
  navn: string;
  beskrivelse: string;
  // Påkrævede kan ikke slås helt fra - mindst én kanal skal være til.
  paakraevet: boolean;
};

// Rækkefølgen er den, typerne vises i på indstillingssiden.
export const NOTIFIKATION_TYPER: readonly NotifikationTypeInfo[] = [
  { type: "vundet", navn: "Vundet eller solgt", beskrivelse: "Når du vinder en auktion, eller din auktion bliver solgt.", paakraevet: true },
  { type: "betalingsfrist", navn: "Betalingsfrist", beskrivelse: "Påmindelser om at betale, når sælgeren forlænger fristen, og hvis en handel bliver annulleret, fordi den ikke blev betalt.", paakraevet: true },
  { type: "betaling_modtaget", navn: "Køberen har betalt", beskrivelse: "Når køberen har betalt, og du skal sende varen – eller når en afhentning skal aftales.", paakraevet: true },
  { type: "pakke_sendt", navn: "Pakken er sendt", beskrivelse: "Når sælgeren har sendt din vare.", paakraevet: true },
  { type: "pakke_indleveret", navn: "Pakken er indleveret", beskrivelse: "Når fragtfirmaet har modtaget den pakke, du sender.", paakraevet: true },
  { type: "pakke_leveret", navn: "Pakken er kommet frem", beskrivelse: "Når pakken er kommet frem til køberen.", paakraevet: true },
  { type: "udbetaling", navn: "Udbetaling", beskrivelse: "Når pengene er sendt til din udbetalingskonto, eller du mangler at oprette den.", paakraevet: true },
  { type: "sag", navn: "Sager", beskrivelse: "Nyt i en sag om en handel, og når BidHamr åbner en samtale med dig.", paakraevet: true },
  { type: "advarsel", navn: "Advarsler", beskrivelse: "Når du får en advarsel fra BidHamr, eller når noget, du har skrevet (fx en bedømmelse), bliver skjult.", paakraevet: true },
  { type: "afgoerelse", navn: "Afgørelser og klager", beskrivelse: "Når BidHamr fjerner eller begrænser noget af dit indhold eller din konto, svar på dine klager, og svar på det, du har anmeldt. Mail sendes altid.", paakraevet: true },
  { type: "andenchance", navn: "Tilbud til næste byder", beskrivelse: "Når du får tilbudt en vare, eller når byderen svarer på dit tilbud.", paakraevet: true },
  { type: "overbudt", navn: "Du er overbudt", beskrivelse: "Når en anden byder mere end dig.", paakraevet: false },
  { type: "bud_paa_egen", navn: "Bud på din auktion", beskrivelse: "Når nogen byder på en af dine auktioner.", paakraevet: false },
  { type: "like", navn: "Nogen har liket din auktion", beskrivelse: "Når nogen gemmer din auktion som favorit.", paakraevet: false },
  { type: "auktion_status", navn: "Auktion på pause", beskrivelse: "Når BidHamr sætter en auktion, du sælger eller har budt på, på pause, og når den åbner igen.", paakraevet: false },
  { type: "fulgt_slutter_snart", navn: "Favorit slutter snart", beskrivelse: "En time før en auktion, du har gemt, slutter.", paakraevet: false },
  { type: "ny_auktion_fulgt_saelger", navn: "Ny auktion fra en sælger, du følger", beskrivelse: "Når en sælger, du følger, sætter en ny vare til salg.", paakraevet: false },
  { type: "gemt_soegning", navn: "Gemte søgninger", beskrivelse: "Når nye auktioner matcher en søgning, du har gemt. Højst én besked pr. søgning hver 6. time.", paakraevet: false },
  { type: "ny_besked", navn: "Nye beskeder", beskrivelse: "Når du får en ny besked i en handel eller fra BidHamr.", paakraevet: false },
  { type: "spoergsmaal", navn: "Spørgsmål til auktioner", beskrivelse: "Når nogen stiller et spørgsmål til din auktion, eller sælgeren svarer på dit spørgsmål.", paakraevet: false },
  { type: "bedoemmelse", navn: "Dine bedømmelser", beskrivelse: "Når en sælger svarer på en bedømmelse, du har givet, eller når noget, du har skrevet, er synligt igen efter en gennemgang.", paakraevet: false },
] as const;

export const ALLE_TYPER: readonly NotifikationType[] = NOTIFIKATION_TYPER.map((t) => t.type);

const PAAKRAEVEDE = new Set<NotifikationType>(
  NOTIFIKATION_TYPER.filter((t) => t.paakraevet).map((t) => t.type),
);

export function erKendtType(type: unknown): type is NotifikationType {
  return typeof type === "string" && (ALLE_TYPER as readonly string[]).includes(type);
}

export function erPaakraevet(type: NotifikationType): boolean {
  return PAAKRAEVEDE.has(type);
}

export function typeInfo(type: NotifikationType): NotifikationTypeInfo {
  return NOTIFIKATION_TYPER.find((t) => t.type === type)!;
}

export type Kanaler = { klokke: boolean; mail: boolean; push: boolean };

// Standard, når brugeren ikke har gemt noget for typen: alt til.
export const STANDARD_KANALER: Kanaler = { klokke: true, mail: true, push: true };
