// BidHamr-bot: konfiguration og rene regler (ingen server-afhængigheder, så
// enhedstestene kan bruge dem).
//
// Nøglen hedder ANTHROPIC_API_KEY. Mangler den, er botten skjult overalt
// (chatboblen vises ikke, og endpoints svarer "ikke tilgængelig") - den
// fejler aldrig. Modellen kommer fra BIDHAMR_BOT_MODEL med standard
// claude-haiku-5-5 (Filip, 27. okt. 2026) og skal være en af de tilladte
// modeller med kendte priser (BOT_MODELLER) - ellers er botten skjult, så en
// tastefejl aldrig kører en ukendt (måske dyr) model. Effort er 'low'.

export const BOT_STANDARD_MODEL = "claude-haiku-5-5";
export const BOT_EFFORT = "low" as const;

// Længste besked fra brugeren (tegn). Samme loft i databasen (bot_ny_besked).
export const BOT_MAKS_TEGN = 1000;
// Antal tidligere beskeder, der sendes med til modellen.
export const BOT_MAKS_HISTORIK = 20;
// Loft over runder i værktøjsløkken pr. svar.
export const BOT_MAKS_RUNDER = 4;
// max_tokens pr. runde (thinking + svar).
export const BOT_MAKS_TOKENS = 4000;
// Samlet deadline for ét svar (alle runder). Under routens maxDuration (60
// s), så svaret og forbruget altid når at blive gemt (bot_gem_svar).
export const BOT_DEADLINE_MS = 50_000;
// Loftet pr. døgn står i databasen (bot_ny_besked) - her kun til tekster.
export const BOT_LOFT_PR_DOEGN = 30;
// Groft loft over input-tokens pr. runde (systemprompt, værktøjer, op til
// BOT_MAKS_HISTORIK beskeder og værktøjsresultater) - kun til skønnet over
// den højeste pris for ét svar (botMaksPrisUsd). Hellere for højt end for lavt.
// Hævet fra 30.000 (review 27. okt. 2026): værktøjsresultater og en lang
// historik kan fylde mere end skønnet.
export const BOT_SKOEN_INPUT_PR_RUNDE = 60_000;
// Siden /kontakt (kontaktformularen) - linket ved lofterne.
export const BOT_KONTAKT_STI = "/kontakt";

export function botNoegle(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.ANTHROPIC_API_KEY?.trim();
  return v ? v : null;
}

// Tilladte modeller og deres priser i USD pr. million tokens (input,
// output, cache-læsning, cache-skrivning med 5 minutters TTL).
type Priser = { input: number; output: number; cacheRead: number; cacheWrite: number };
export const BOT_MODELLER = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
} as const satisfies Record<string, Priser>;
export type BotModelNavn = keyof typeof BOT_MODELLER;

export function erTilladtModel(v: string): v is BotModelNavn {
  return Object.prototype.hasOwnProperty.call(BOT_MODELLER, v);
}

// Modellen fra BIDHAMR_BOT_MODEL (tom = standard). null = ukendt model -
// botten kører så ikke (botAktiv er false).
export function botModel(env: NodeJS.ProcessEnv = process.env): BotModelNavn | null {
  const v = env.BIDHAMR_BOT_MODEL?.trim().toLowerCase();
  if (!v) return BOT_STANDARD_MODEL;
  return erTilladtModel(v) ? v : null;
}

export function botAktiv(env: NodeJS.ProcessEnv = process.env): boolean {
  return botNoegle(env) !== null && botModel(env) !== null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type BotInput = { samtaleId: string | null; besked: string };

// Validerer kroppen fra hjemmesiden og appen ({ samtaleId?, besked }).
export function laesBotInput(krop: unknown): BotInput | { fejl: string; kode: string } {
  if (!krop || typeof krop !== "object" || Array.isArray(krop)) return { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" };
  const k = krop as Record<string, unknown>;
  const samtale = k.samtaleId;
  if (samtale !== undefined && samtale !== null && (typeof samtale !== "string" || !UUID_RE.test(samtale))) {
    return { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" };
  }
  if (typeof k.besked !== "string") return { fejl: "Skriv en besked.", kode: "tom" };
  const besked = k.besked.replace(/\r\n?/g, "\n").trim();
  if (!besked) return { fejl: "Skriv en besked.", kode: "tom" };
  if (besked.length > BOT_MAKS_TEGN) {
    return { fejl: `Beskeden må højst være ${BOT_MAKS_TEGN.toLocaleString("da-DK")} tegn.`, kode: "for_lang" };
  }
  return { samtaleId: (samtale as string | null | undefined) ?? null, besked };
}

export function laesEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}

// Svarkoderne fra bot_ny_besked som danske fejl (HTTP-status, tekst).
// grund er 'grund' fra databasen ved 'loft_alle' (anon/anon_usd = loftet for
// alle uden login, så indloggede kan stadig skrive).
export function loftFejl(kode: string, grund?: string | null): { status: number; fejl: string; kode: string } {
  switch (kode) {
    case "loft_bruger_usd":
      return {
        status: 429,
        kode,
        fejl: "Du har stillet mange spørgsmål til BidHamr-bot i dag, så den holder pause for dig til i morgen. Skriv til os via kontaktformularen på /kontakt, så hjælper en medarbejder dig.",
      };
    case "loft_bruger":
    case "loft_ip":
      return {
        status: 429,
        kode,
        fejl: `Du har skrevet ${BOT_LOFT_PR_DOEGN} beskeder til BidHamr-bot det seneste døgn. Prøv igen senere, eller kontakt en rigtig medarbejder.`,
      };
    case "loft_alle":
      if (grund === "anon" || grund === "anon_usd") {
        return {
          status: 429,
          kode,
          fejl: "BidHamr-bot holder en kort pause for besøgende uden login. Log ind for at fortsætte, eller skriv til os via kontaktformularen på /kontakt.",
        };
      }
      return {
        status: 429,
        kode,
        fejl: "BidHamr-bot holder en kort pause lige nu. Prøv igen senere, eller skriv til os via kontaktformularen på /kontakt.",
      };
    case "svar_i_gang":
      return { status: 409, kode, fejl: "BidHamr-bot svarer stadig på din sidste besked. Vent, til svaret er kommet, og skriv så igen." };
    case "samtale_fuld":
      return { status: 409, kode, fejl: "Samtalen er blevet lang. Start en ny samtale, eller kontakt en rigtig medarbejder." };
    case "ukendt_samtale":
      return { status: 409, kode, fejl: "Samtalen findes ikke længere. Start en ny samtale." };
    case "ugyldig_laengde":
      return { status: 400, kode, fejl: `Beskeden må højst være ${BOT_MAKS_TEGN.toLocaleString("da-DK")} tegn.` };
    default:
      return { status: 500, kode: "fejl", fejl: "Noget gik galt. Prøv igen om lidt." };
  }
}

// Ukendt model (kører ikke - se botModel): Opus-priser, så omkostningen
// hellere overvurderes end undervurderes.
const UKENDT: Priser = BOT_MODELLER["claude-opus-5-5"];

export type BotForbrug = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function botPrisUsd(model: string, f: BotForbrug): number {
  const p: Priser = erTilladtModel(model) ? BOT_MODELLER[model] : UKENDT;
  const usd = (f.input * p.input + f.output * p.output + f.cacheRead * p.cacheRead + f.cacheWrite * p.cacheWrite) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

// Den højeste pris for ét svar med modellen (alle runder, fuld output og
// fuld input uden cache). Sendes til bot_ny_besked som skøn for svar, der er
// i gang, så mange samtidige beskeder ikke kan løbe forbi USD-lofterne.
export function botMaksPrisUsd(model: string): number {
  return botPrisUsd(model, {
    input: BOT_MAKS_RUNDER * BOT_SKOEN_INPUT_PR_RUNDE,
    output: BOT_MAKS_RUNDER * BOT_MAKS_TOKENS,
    cacheRead: 0,
    cacheWrite: 0,
  });
}

// Kan ét svar med modellen koste mere end loftet pr. bruger pr. døgn? Så
// kan én bruger komme over sit loft med ét svar (loftet tjekkes, før svaret
// begynder). Vises som advarsel på /admin/bot (fx ved Opus).
export function botSvarOverBrugerLoft(model: string, brugerLoftUsd: number): boolean {
  return botMaksPrisUsd(model) > brugerLoftUsd;
}

// Chefens indstillinger på /admin/bot (bot_indstillinger). Samme grænser
// som tjekket i databasen (bot_indstillinger_vaerdier). Andelen uden login
// skrives i procent (0-100) og gemmes som 0-1.
export type BotIndstillinger = {
  doegnloft_usd: number;
  anon_andel: number;
  bruger_loft_usd: number;
  doegnloft_anon: number;
};

const tal = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function laesBotIndstillinger(f: {
  doegnloft_usd?: unknown;
  anon_procent?: unknown;
  bruger_loft_usd?: unknown;
  doegnloft_anon?: unknown;
}): BotIndstillinger | { fejl: string } {
  const usd = tal(f.doegnloft_usd);
  if (usd === null || usd > 1000) return { fejl: "Døgnloftet skal være mellem 0 og 1.000 USD." };
  const procent = tal(f.anon_procent);
  if (procent === null || procent > 100) return { fejl: "Andelen uden login skal være mellem 0 og 100 %." };
  const bruger = tal(f.bruger_loft_usd);
  if (bruger === null || bruger > 100) return { fejl: "Loftet pr. bruger skal være mellem 0 og 100 USD." };
  const anon = tal(f.doegnloft_anon);
  if (anon === null || !Number.isInteger(anon) || anon > 1_000_000) {
    return { fejl: "Beskeder uden login skal være et helt tal mellem 0 og 1.000.000." };
  }
  return {
    doegnloft_usd: Math.round(usd * 100) / 100,
    anon_andel: Math.round(procent * 10) / 1000,
    bruger_loft_usd: Math.round(bruger * 10_000) / 10_000,
    doegnloft_anon: anon,
  };
}
