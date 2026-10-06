import "server-only";

// Digital Services Act - serverdelen, som hjemmesiden og appen deler:
// - opretAnmeldelse(): anmeld ulovligt indhold (art. 16) - bruges af server
//   action'en (src/app/actions/dsa.ts) og POST /api/dsa/anmeld (appen).
// - udfoerIndgreb(): den fælles funktion for ALLE staff-indgreb (art. 17).
//   Kalder dsa_indgreb i databasen (indgreb + begrundelse i samme
//   transaktion) og sender begrundelsen til brugeren.
// - Signerede links (HMAC), så en bruger uden login (anmelder) eller med en
//   lukket/suspenderet konto kan se sin sag og klage via mailen.
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import {
  DSA_BEGRUNDELSE_MAKS,
  DSA_BEGRUNDELSE_MIN,
  DSA_EMAIL_MAKS,
  DSA_NAVN_MAKS,
  erAnmeldKategori,
  erIndholdType,
  kraeverKontaktoplysninger,
  type IndholdType,
} from "@/lib/dsa/regler";
import { anmeldelseSti, erUuid } from "@/lib/dsa/link";
import { send } from "@/lib/notifikationer/send";
import { logDriftFejl } from "@/lib/drift";
import { notificerAuktionPauser } from "@/lib/notifikationer/auktionPause";
import {
  notificerAfgoerelse,
  notificerAnmeldelseSvar,
  sendAnmeldelseKvittering,
} from "@/lib/dsa/notifikationer";

type Admin = ReturnType<typeof createAdminClient>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Udfyldes formularen hurtigere end dette, er det næsten altid en robot.
const MIN_SEKUNDER = 3;

// ------------------------------------------------------------------ Placering

// Den præcise placering (art. 16(2)(b)) - bygges af serveren ud fra id'et,
// så den altid peger det rigtige sted hen. null, hvis indholdet ikke findes.
export async function placeringFor(admin: Admin, type: IndholdType, id: string): Promise<string | null> {
  switch (type) {
    case "auktion": {
      const { data } = await admin.from("auctions").select("id").eq("id", id).maybeSingle();
      return data ? `/auktion/${id}` : null;
    }
    case "profil": {
      const { data } = await admin.from("users").select("id").eq("id", id).maybeSingle();
      return data ? `/profil/${id}` : null;
    }
    case "spoergsmaal":
    case "spoergsmaal_svar": {
      const { data } = await admin
        .from("auction_questions")
        .select("auction_id")
        .eq("id", id)
        .maybeSingle<{ auction_id: string }>();
      return data ? `/auktion/${data.auction_id}#spoergsmaal-${id}` : null;
    }
    case "bedoemmelse":
    case "bedoemmelse_svar": {
      const { data } = await admin
        .from("ratings")
        .select("til_bruger_id")
        .eq("id", id)
        .maybeSingle<{ til_bruger_id: string }>();
      return data ? `/profil/${data.til_bruger_id}#bedoemmelse-${id}` : null;
    }
    default:
      return null;
  }
}

// Et link, som brugeren selv har indsat på /dsa/anmeld. Kender vi siden,
// knyttes anmeldelsen til indholdet; ellers gemmes linket som tekst.
export function fortolkLink(raa: string): { type: IndholdType; id: string | null } {
  const tekst = raa.trim();
  try {
    const url = new URL(tekst, "https://bidhamr.dk");
    const vaert = url.hostname.replace(/^www\./, "");
    const egen = vaert === "bidhamr.dk" || vaert === "localhost" || !/^https?:/i.test(tekst);
    if (egen) {
      const hash = url.hash.replace(/^#/, "");
      const auk = /^\/auktion\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
      const prof = /^\/profil\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
      const sp = /^spoergsmaal-([0-9a-f-]{36})$/i.exec(hash);
      const bd = /^bedoemmelse-([0-9a-f-]{36})$/i.exec(hash);
      if (auk && sp && erUuid(sp[1])) return { type: "spoergsmaal", id: sp[1].toLowerCase() };
      if (auk && erUuid(auk[1])) return { type: "auktion", id: auk[1].toLowerCase() };
      if (prof && bd && erUuid(bd[1])) return { type: "bedoemmelse", id: bd[1].toLowerCase() };
      if (prof && erUuid(prof[1])) return { type: "profil", id: prof[1].toLowerCase() };
    }
  } catch {
    // Ikke et link - gemmes som tekst.
  }
  return { type: "andet", id: null };
}

// ------------------------------------------------------------------ Anmeld (art. 16)

export type AnmeldInput = {
  type?: unknown;
  id?: unknown;
  link?: unknown;
  kategori?: unknown;
  begrundelse?: unknown;
  navn?: unknown;
  email?: unknown;
  godTro?: unknown;
  // Spambeskyttelse (kun hjemmesiden): honeypot og tidspunkt for formularen.
  honeypot?: unknown;
  startet?: unknown;
};

// Uden login får anmelderen ALDRIG sagsnummer eller link i svaret (kun i
// kvitteringsmailen) - ellers kunne man med en andens e-mail se, om der
// findes en anmeldelse, og følge den. Svaret er det samme, uanset om
// anmeldelsen blev oprettet, indholdet ikke findes, eller e-mailen tilhører
// den, der ejer indholdet (så oprettes ingen sag).
export type AnmeldResultat =
  | { ok: true; sagsnummer: string; statusSti: string; findes?: true }
  | { ok: true; anonym: true }
  | { fejl: string; kode: string };

const ANONYMT_OK: AnmeldResultat = { ok: true, anonym: true };

const KODE_FEJL: Record<string, string> = {
  ugyldig_kategori: "Vælg, hvad anmeldelsen handler om.",
  ugyldig_type: "Vi kunne ikke se, hvad du vil anmelde.",
  ikke_fundet: "Indholdet findes ikke længere.",
  sig_selv: "Du kan ikke anmelde dit eget indhold.",
  begrundelse: `Forklar med ${DSA_BEGRUNDELSE_MIN}-${DSA_BEGRUNDELSE_MAKS} tegn, hvorfor indholdet er ulovligt eller bryder reglerne.`,
  god_tro: "Bekræft, at oplysningerne er rigtige efter din bedste overbevisning.",
  anmelder_mangler: "Skriv dit navn og en gyldig e-mail, så vi kan give dig svar.",
  navn_for_langt: `Navnet må højst være ${DSA_NAVN_MAKS} tegn.`,
  ugyldig_placering: "Indsæt et link til det, du vil anmelde.",
  for_mange: FOR_MANGE_FORSOEG,
};

const GENERISK = "Noget gik galt. Prøv igen om lidt.";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// brugerId: den indloggede bruger (verificeret af kalderen) eller null.
// ip: klientens IP (til rate limit).
export async function opretAnmeldelse(
  input: AnmeldInput,
  ctx: { brugerId: string | null; ip: string; kilde: "web" | "app" },
): Promise<AnmeldResultat> {
  const fejl = (kode: string): AnmeldResultat => ({ kode, fejl: KODE_FEJL[kode] ?? GENERISK });

  // Honeypot: robotten får "ok" uden noget gemt, så den ikke prøver igen.
  if (ctx.kilde === "web" && str(input.honeypot) !== "") return ANONYMT_OK;
  const anonym = !ctx.brugerId;

  const kategori = str(input.kategori);
  const begrundelse = str(input.begrundelse);
  let navn = str(input.navn);
  let email = str(input.email).toLowerCase();
  if (!erAnmeldKategori(kategori)) return fejl("ugyldig_kategori");
  if (begrundelse.length < DSA_BEGRUNDELSE_MIN || begrundelse.length > DSA_BEGRUNDELSE_MAKS) {
    return fejl("begrundelse");
  }
  if (input.godTro !== true && input.godTro !== "on" && input.godTro !== "true") return fejl("god_tro");
  if (navn.length > DSA_NAVN_MAKS) return fejl("navn_for_langt");
  if (email && (email.length > DSA_EMAIL_MAKS || !EMAIL.test(email))) return fejl("anmelder_mangler");

  // Tidsfælde (kun hjemmesiden). Et menneske, der er hurtigt, får en synlig
  // besked i stedet for et stille "ok".
  if (ctx.kilde === "web") {
    const raa = str(input.startet);
    const start = /^\d{1,16}$/.test(raa) ? Number(raa) : NaN;
    if (!Number.isFinite(start) || start <= 0 || Date.now() - start < MIN_SEKUNDER * 1000) {
      return { kode: "for_hurtig", fejl: "Vent et øjeblik, og prøv igen." };
    }
  }

  // Hvad anmeldes? Enten type + id (knappen på indholdet) eller et link.
  let type: IndholdType;
  let id: string | null;
  const raaType = str(input.type);
  if (raaType && raaType !== "andet") {
    if (!erIndholdType(raaType) || !erUuid(input.id)) return fejl("ugyldig_type");
    type = raaType;
    id = (input.id as string).toLowerCase();
  } else {
    const link = str(input.link);
    if (!link || link.length > 500) return fejl("ugyldig_placering");
    ({ type, id } = fortolkLink(link));
  }

  // IP-loftet tjekkes, FØR indholdet slås op (ingen gratis opslag).
  if (!(await tjekGraenser([[anonym ? "dsa_ip" : "dsa_ip_indlogget", ctx.ip]]))) return fejl("for_mange");

  const admin = createAdminClient();
  let placering: string;
  if (type === "andet" || !id) {
    placering = str(input.link).slice(0, 500);
    if (!placering) return fejl("ugyldig_placering");
  } else {
    const p = await placeringFor(admin, type, id);
    // Uden login afsløres det ikke, om indholdet findes.
    if (!p) return anonym ? ANONYMT_OK : fejl("ikke_fundet");
    placering = p;
  }

  // Indlogget: navn og e-mail fra kontoen (kan ikke forfalskes).
  if (ctx.brugerId) {
    const { data: u } = await admin
      .from("users")
      .select("navn, email")
      .eq("id", ctx.brugerId)
      .maybeSingle<{ navn: string | null; email: string | null }>();
    navn = (u?.navn ?? navn).slice(0, DSA_NAVN_MAKS);
    email = (u?.email ?? email).toLowerCase();
  } else if (kraeverKontaktoplysninger(kategori) && (!navn || !email)) {
    return fejl("anmelder_mangler");
  }

  // Særskilte lofter for anmeldere med og uden login. Misbrug af børn
  // undtages fra det fælles loft (IP-loftet ovenfor gælder stadig).
  const graenser: Parameters<typeof tjekGraenser>[0] = [];
  if (kategori !== "misbrug_boern") graenser.push([anonym ? "dsa_alle_anonym" : "dsa_alle_indlogget", "alle"]);
  if (ctx.brugerId) graenser.push(["dsa_bruger", ctx.brugerId]);
  if (graenser.length > 0 && !(await tjekGraenser(graenser))) return fejl("for_mange");
  // Loftet pr. e-mail uden login giver det neutrale svar - ellers kunne man
  // se, om en andens e-mail er brugt til mange anmeldelser.
  if (anonym && email && !(await tjekGraenser([["dsa_email", email]]))) return ANONYMT_OK;

  const { data, error } = await admin.rpc("dsa_anmeldelse_opret", {
    p_anmelder: ctx.brugerId,
    p_type: type,
    p_id: id,
    p_placering: placering,
    p_kategori: kategori,
    p_begrundelse: begrundelse,
    p_navn: navn || null,
    p_email: email || null,
    p_god_tro: true,
  });
  if (error) {
    console.error("dsa_anmeldelse_opret fejlede:", error.code, error.message);
    return { kode: "fejl", fejl: GENERISK };
  }
  const svar = (data ?? {}) as { kode?: string; id?: string; sagsnummer?: string };
  if (svar.kode === "ok" && svar.id) {
    const anmeldelseId = svar.id;
    after(() => sendAnmeldelseKvittering(anmeldelseId));
  }
  // Uden login: altid det samme neutrale svar (også 'ok' uden sag fra
  // databasen). Sagsnummer og link kommer kun i kvitteringsmailen.
  if (anonym && (svar.kode === "ok" || svar.kode === "for_mange")) return ANONYMT_OK;
  if ((svar.kode === "ok" || svar.kode === "findes") && svar.id && svar.sagsnummer) {
    const anmeldelseId = svar.id;
    return {
      ok: true,
      sagsnummer: svar.sagsnummer,
      statusSti: anmeldelseSti(anmeldelseId),
      ...(svar.kode === "findes" ? { findes: true as const } : {}),
    };
  }
  return fejl(svar.kode ?? "fejl");
}

// ------------------------------------------------------------------ Indgreb (art. 17)

export type IndgrebInput = {
  staffId: string;
  type: IndholdType;
  id: string;
  handling: string;
  regel: string;
  // Fakta og omstændigheder - vises for brugeren.
  fakta: string;
  internNote?: string | null;
  anmeldelseId?: string | null;
  automatiskOpdaget?: boolean;
  varighed?: "1" | "7" | "permanent";
  sagId?: string | null;
  svarTilAnmelder?: string | null;
  politiUnderrettet?: boolean;
};

export type IndgrebResultat =
  | { ok: true; afgoerelseId: string; brugerId: string }
  | { ok: false; kode: string };

// DEN fælles funktion: alle staff-handlinger, der fjerner/skjuler indhold
// eller suspenderer/lukker en konto, går herigennem. Kaster ved databasefejl.
// Brugeren (og evt. anmelderne) får besked efter svaret (after()); cron'en
// samler op, hvis det fejler.
export async function udfoerIndgreb(admin: Admin, input: IndgrebInput): Promise<IndgrebResultat> {
  const ekstra: Record<string, unknown> = {};
  if (input.varighed) ekstra.varighed = input.varighed;
  if (input.sagId) ekstra.sag_id = input.sagId;
  if (input.svarTilAnmelder) ekstra.svar_til_anmelder = input.svarTilAnmelder;
  if (input.politiUnderrettet) ekstra.politi_underrettet = true;

  const { data, error } = await admin.rpc("dsa_indgreb", {
    p_medarbejder: input.staffId,
    p_type: input.type,
    p_id: input.id,
    p_handling: input.handling,
    p_regel: input.regel,
    p_fakta: input.fakta,
    p_intern_note: input.internNote || null,
    p_anmeldelse: input.anmeldelseId || null,
    p_automatisk_opdaget: input.automatiskOpdaget === true,
    p_ekstra: ekstra,
  });
  if (error) throw new Error(`dsa_indgreb: ${error.message}`);
  const svar = (data ?? {}) as {
    kode?: string;
    afgoerelse_id?: string;
    bruger_id?: string;
    anmeldelser?: string[];
    // Den anden part, hvis et spørgsmål med svar blev skjult.
    ekstra_afgoerelser?: string[];
  };
  if (svar.kode !== "ok" || !svar.afgoerelse_id || !svar.bruger_id) {
    return { ok: false, kode: svar.kode ?? "ukendt" };
  }
  const afgId = svar.afgoerelse_id;
  const anmeldelser = svar.anmeldelser ?? [];
  const andenPart = svar.ekstra_afgoerelser ?? [];
  after(async () => {
    await notificerAfgoerelse(afgId);
    for (const x of andenPart) await notificerAfgoerelse(x);
    for (const a of anmeldelser) await notificerAnmeldelseSvar(a);
    if (input.type === "auktion") await notificerBydere(admin, afgId);
  });
  return { ok: true, afgoerelseId: afgId, brugerId: svar.bruger_id };
}

// Når BidHamr skjuler, fjerner eller stopper en igangværende auktion, får
// alle, der har budt, en kort besked. Bydere er ikke part i afgørelsen, så
// beskeden har ingen begrundelse, og sælgerens identitet nævnes ikke.
// Skjul = pause (Filip, 6. okt. 2026): beskeden sendes af
// notificerAuktionPauser ("Auktionen er sat på pause ... Dit bud gælder
// stadig.", type 'auktion_status'). Fjern/stop: almindelig type ('overbudt' -
// status for brugerens bud). Idempotent pr. afgørelse og byder. Kaster aldrig.
async function notificerBydere(admin: Admin, afgoerelseId: string) {
  try {
    const { data: afg } = await admin
      .from("dsa_afgoerelser")
      .select("handling, foer_status, indhold_id, bruger_id")
      .eq("id", afgoerelseId)
      .maybeSingle<{ handling: string; foer_status: string | null; indhold_id: string; bruger_id: string }>();
    if (!afg) return;
    // Kun en auktion, der var i gang: på en afsluttet auktion er buddene
    // allerede afgjort (handlen håndteres som en sag).
    if (afg.foer_status !== "aktiv") return;

    if (afg.handling === "auktion_skjult") {
      await notificerAuktionPauser(afg.indhold_id);
      return;
    }

    const [{ data: auktion }, { data: bud }] = await Promise.all([
      admin.from("auctions").select("titel").eq("id", afg.indhold_id).maybeSingle<{ titel: string }>(),
      admin.from("bids").select("bruger_id").eq("auktion_id", afg.indhold_id).limit(1000),
    ]);
    const bydere = [...new Set((bud ?? []).map((b) => b.bruger_id as string))].filter(
      (b) => b !== afg.bruger_id,
    );
    if (bydere.length === 0) return;

    const titel = auktion?.titel ? `"${auktion.titel}"` : "auktionen";
    const tekst = {
      titel:
        afg.handling === "auktion_fjernet"
          ? "En auktion, du har budt på, er fjernet af BidHamr"
          : "En auktion, du har budt på, er stoppet af BidHamr",
      tekst: `BidHamr har ${afg.handling === "auktion_fjernet" ? "fjernet" : "stoppet"} ${titel}. Auktionen er annulleret, og dit bud gælder ikke længere. Du skal ikke betale noget.`,
    };

    for (const byder of bydere) {
      await send(byder, "overbudt", {
        ...tekst,
        link: `/auktion/${afg.indhold_id}`,
        data: { auction_id: afg.indhold_id },
        noegle: `dsa_byder:${afgoerelseId}:${byder}`,
      });
    }
  } catch (err) {
    await logDriftFejl({ kilde: "notifikation", hvor: "dsa: besked til bydere", fejl: err });
  }
}

// Danske tekster til fejlkoderne fra dsa_indgreb (og de funktioner, den kalder).
export const INDGREB_FEJL: Record<string, string> = {
  uaendret: "Det er allerede gjort.",
  ingen_adgang: "Du har ikke adgang til at gøre dette.",
  ugyldig_handling: "Det indgreb passer ikke til indholdet.",
  ugyldig_regel: "Vælg hvilken regel eller lov, indholdet bryder.",
  fakta_mangler: "Skriv en begrundelse til brugeren: hvad har brugeren gjort?",
  for_lang_tekst: "En af teksterne er for lang (højst 2000 tegn).",
  ikke_fundet: "Indholdet findes ikke.",
  inhabil: "Du kan ikke behandle dette, fordi du selv er part (eller har handlet med brugeren). Lad en kollega tage den.",
  staff: "Medarbejdere, admins og chefer kan ikke rammes af dette herfra.",
  har_handel: "Auktionen har en handel og kan ikke fjernes. Håndter den som en sag – eller skjul den.",
  afsluttet: "Auktionen er afsluttet og kan ikke fjernes. Skjul den i stedet.",
  ikke_aktiv: "Auktionen er ikke i gang.",
  allerede_lukket: "Kontoen er allerede lukket permanent.",
  anmeldelse_ugyldig: "Anmeldelsen er allerede behandlet eller handler om noget andet. Genindlæs siden.",
  ugyldig_varighed: "Vælg, hvor længe kontoen skal suspenderes.",
  begrundelse_mangler: "Skriv en begrundelse.",
  aarsag_mangler: "Skriv en begrundelse.",
  ugyldig_bruger: "Brugeren findes ikke.",
  sig_selv: "Du kan ikke gøre dette mod dig selv.",
  ugyldig_sag: "Sagen hører ikke til brugeren.",
};

export function indgrebFejl(kode: string): string {
  return INDGREB_FEJL[kode] ?? "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
}

// Bruges af server actions, der ikke selv har en admin-klient.
export function dsaAdmin(): Admin {
  return createAdminClient();
}
