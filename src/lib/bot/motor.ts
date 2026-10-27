import "server-only";

// BidHamr-bot: ét svar på én besked - fælles for hjemmesiden (POST /api/bot,
// cookie-session) og appen (POST /api/app/bot, Bearer-token).
//
// 1. Loftet tjekkes og beskeden registreres atomisk i databasen
//    (bot_ny_besked, service-role) - FØR modellen kaldes.
// 2. Historikken hentes fra databasen (aldrig fra klienten), så ingen kan
//    plante falske bot-svar i samtalen.
// 3. Manuel værktøjsløkke med streaming og et loft på BOT_MAKS_RUNDER runder.
//    Værktøjerne læser kun brugerens egne data med brugerens egen session.
//    Ordet "forsikring" filtreres fra svaret (filter.ts).
// 4. Svaret og forbruget (tokens og pris) gemmes (bot_gem_svar) - også når
//    svaret afbrydes (brugeren lukker, fejl eller den samlede deadline
//    BOT_DEADLINE_MS, som ligger under routens maxDuration).
//
// Svaret streames som NDJSON (én JSON pr. linje):
//   { "type": "samtale", "samtaleId": "<uuid>" }   altid først
//   { "type": "tekst", "tekst": "<stykke>" }        bottens tekst, i bidder
//   { "type": "medarbejder" }                       vis "Kontakt en rigtig medarbejder" tydeligt
//   { "type": "fejl", "fejl": "<dansk tekst>" }     svaret blev afbrudt
//   { "type": "slut" }                              altid sidst

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { hemmeligNoegle } from "@/lib/supabase/noeglerServer";
import { ipNoegle } from "@/lib/ipNoegle";
import { logDriftFejl } from "@/lib/drift";
import { SUPPORT_EMAIL } from "@/lib/tryghed";
import { kontaktSupportMail } from "@/lib/mails/kontakt";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import {
  BOT_DEADLINE_MS,
  BOT_EFFORT,
  BOT_MAKS_HISTORIK,
  BOT_MAKS_RUNDER,
  BOT_MAKS_TOKENS,
  type BotInput,
  botModel,
  botNoegle,
  botPrisUsd,
  loftFejl,
} from "@/lib/bot/konfig";
import { botKontekst, botSystemprompt } from "@/lib/bot/viden";
import { BOT_VAERKTOEJER, koerVaerktoej } from "@/lib/bot/vaerktoejer";
import { lavOrdFilter } from "@/lib/bot/filter";

export const BOT_IKKE_TILGAENGELIG = { status: 404, fejl: "BidHamr-bot er ikke tilgængelig.", kode: "ikke_tilgaengelig" } as const;

const AFVIST_TEKST =
  "Det kan jeg desværre ikke hjælpe med. Tryk på \"Kontakt en rigtig medarbejder\", så hjælper en af os dig.";
const FEJL_TEKST =
  "BidHamr-bot kan ikke svare lige nu. Prøv igen om lidt, eller tryk på \"Kontakt en rigtig medarbejder\".";
const RUNDER_TEKST =
  "Jeg kunne ikke finde et sikkert svar. Tryk på \"Kontakt en rigtig medarbejder\", så hjælper en af os dig.";

// HMAC af IP-adressen (IPv6 pr. /64, src/lib/ipNoegle.ts) - selve adressen
// gemmes aldrig. Hemmeligheden er BOT_IP_SALT, ellers (som før) serverens
// hemmelige Supabase-nøgle.
export function ipHash(ip: string, env: NodeJS.ProcessEnv = process.env): string {
  const salt = env.BOT_IP_SALT?.trim() || hemmeligNoegle();
  return createHmac("sha256", `bidhamr-bot-ip-v1|${salt}`).update(ipNoegle(ip)).digest("hex");
}
export type BotKald = {
  // Klient med brugerens egen session (RLS). null = ikke logget ind.
  supabase: SupabaseClient | null;
  // Den verificerede bruger (auth.getUser). null = ikke logget ind.
  brugerId: string | null;
  ip: string;
  kilde: "web" | "app";
  input: BotInput;
  signal?: AbortSignal;
};

export type BotStart =
  | { stream: ReadableStream<Uint8Array>; samtaleId: string }
  | { status: number; fejl: string; kode: string };

let klient: Anthropic | null = null;
function anthropic(noegle: string): Anthropic {
  if (!klient) klient = new Anthropic({ apiKey: noegle, maxRetries: 1, timeout: 45_000 });
  return klient;
}

// Groft skøn over output-tokens for en runde, der blev afbrudt, før
// modellen sendte det endelige forbrug (ca. 3 tegn pr. token på dansk).
// Hellere for højt end for lavt.
export function skoenOutputTokens(kendte: number, tegn: number): number {
  return Math.max(kendte, Math.ceil(tegn / 3));
}

async function hentHistorik(samtaleId: string): Promise<Anthropic.MessageParam[] | null> {
  const { data, error } = await createAdminClient()
    .from("bot_beskeder")
    .select("rolle, tekst")
    .eq("samtale_id", samtaleId)
    .order("oprettet_kl", { ascending: false })
    .limit(BOT_MAKS_HISTORIK);
  if (error) return null;
  const raekker = ((data ?? []) as { rolle: string; tekst: string }[]).reverse();
  // Første besked skal være fra brugeren.
  while (raekker.length && raekker[0].rolle !== "bruger") raekker.shift();
  return raekker.map((r) => ({ role: r.rolle === "bruger" ? "user" : "assistant", content: r.tekst }));
}

export async function startBotSvar(k: BotKald): Promise<BotStart> {
  const noegle = botNoegle();
  const model = botModel();
  if (!noegle || !model) return BOT_IKKE_TILGAENGELIG;

  // Samlet deadline for hele svaret (under routens maxDuration), så
  // bot_gem_svar altid når at køre.
  const start = Date.now();
  const styring = new AbortController();
  const afbryd = () => styring.abort();
  if (k.signal?.aborted) afbryd();
  else k.signal?.addEventListener("abort", afbryd, { once: true });

  const admin = createAdminClient();
  const hash = ipHash(k.ip || "ukendt");
  const { data, error } = await admin.rpc("bot_ny_besked", {
    p_samtale: k.input.samtaleId,
    p_bruger: k.brugerId,
    p_ip_hash: hash,
    p_kilde: k.kilde,
    p_tekst: k.input.besked,
  });
  if (error) {
    await logDriftFejl({ kilde: "server", sti: "/api/bot", hvor: "bot_ny_besked", fejl: error.message, brugerId: k.brugerId });
    return loftFejl("fejl");
  }
  const svar = data as
    | { kode: string; samtale_id?: string; grund?: string; alarm?: boolean; usd?: number; loft_usd?: number }
    | null;
  if (svar?.kode === "loft_alle" && svar.grund === "usd" && svar.alarm) {
    // Højst én gang i døgnet (bot_indstillinger.usd_alarm_kl). Datoen i
    // teksten gør det til en "ny slags fejl", så drift-alarmen mailer.
    await logDriftFejl({
      kilde: "server",
      sti: k.kilde === "app" ? "/api/app/bot" : "/api/bot",
      hvor: "BidHamr-bot: døgnloft i USD",
      fejl: `Døgnloftet er nået (${svar.usd ?? "?"} af ${svar.loft_usd ?? "?"} USD det seneste døgn) - botten holder pause, til forbruget falder. ${new Date().toISOString().slice(0, 10)}`,
    });
  }
  if (!svar || svar.kode !== "ok" || !svar.samtale_id) return loftFejl(svar?.kode ?? "fejl");
  const samtaleId = svar.samtale_id;

  const historik = await hentHistorik(samtaleId);
  if (!historik || historik.length === 0) return loftFejl("fejl");

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lukket = false;
      const send = (obj: Record<string, unknown>) => {
        if (lukket) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          lukket = true;
        }
      };
      send({ type: "samtale", samtaleId });

      const forbrug = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const brugte: string[] = [];
      let tekst = "";
      let stop: string = "end_turn";
      let runder = 0;
      let medarbejder = false;
      let tidenGik = false;
      const messages: Anthropic.MessageParam[] = [...historik];
      const filter = lavOrdFilter();
      // Den igangværende runde (til forbruget, hvis den afbrydes).
      let aktiv: ReturnType<Anthropic["messages"]["stream"]> | null = null;
      let rundeTegn = 0;

      const udsend = (t: string) => {
        if (!t) return;
        tekst += t;
        send({ type: "tekst", tekst: t });
      };
      const skriv = (t: string) => udsend(filter.skub(t));
      const toem = () => udsend(filter.toem());

      const timer = setTimeout(
        () => {
          tidenGik = true;
          afbryd();
        },
        Math.max(BOT_DEADLINE_MS - (Date.now() - start), 0),
      );

      try {
        for (;;) {
          if (runder >= BOT_MAKS_RUNDER) {
            stop = "runder";
            skriv(`${tekst ? "\n\n" : ""}${RUNDER_TEKST}`);
            medarbejder = true;
            break;
          }
          runder++;
          if (tekst && !/\s$/.test(tekst)) skriv("\n\n");
          rundeTegn = 0;
          const s = anthropic(noegle).messages.stream(
            {
              model,
              max_tokens: BOT_MAKS_TOKENS,
              output_config: { effort: BOT_EFFORT },
              // Automatisk caching af samtalens hale + et fast cache-punkt
              // på den stabile systemprompt (værktøjerne ligger før den).
              cache_control: { type: "ephemeral" },
              tools: BOT_VAERKTOEJER,
              system: [
                { type: "text", text: botSystemprompt(), cache_control: { type: "ephemeral" } },
                { type: "text", text: botKontekst(!!k.brugerId) },
              ],
              messages,
            },
            { signal: styring.signal },
          );
          aktiv = s;
          s.on("text", (delta) => {
            rundeTegn += delta.length;
            skriv(delta);
          });
          const msg = await s.finalMessage();
          aktiv = null;
          toem();

          forbrug.input += msg.usage.input_tokens ?? 0;
          forbrug.output += msg.usage.output_tokens ?? 0;
          forbrug.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
          forbrug.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
          stop = msg.stop_reason ?? "ukendt";

          if (msg.stop_reason === "refusal") {
            // Ingen server-side fallback på Haiku: et pænt dansk svar.
            skriv(`${tekst && !/\s$/.test(tekst) ? "\n\n" : ""}${AFVIST_TEKST}`);
            medarbejder = true;
            break;
          }
          const vaerktoejsKald = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          if (msg.stop_reason !== "tool_use" || vaerktoejsKald.length === 0) break;

          messages.push({ role: "assistant", content: msg.content });
          const resultater: Anthropic.ToolResultBlockParam[] = [];
          for (const kald of vaerktoejsKald) {
            brugte.push(kald.name);
            const r = await koerVaerktoej(kald.name, k.supabase, k.brugerId);
            if (r.medarbejder) medarbejder = true;
            resultater.push({ type: "tool_result", tool_use_id: kald.id, content: r.indhold, ...(r.fejl ? { is_error: true } : {}) });
          }
          if (medarbejder) send({ type: "medarbejder" });
          messages.push({ role: "user", content: resultater });
        }
        toem();
        if (!tekst.trim()) {
          skriv(RUNDER_TEKST);
          toem();
          medarbejder = true;
        }
      } catch (err) {
        toem();
        // Forbruget i den afbrudte runde tælles med: input (og cache) står i
        // message_start; output skønnes ud fra den tekst, der nåede frem.
        if (aktiv) {
          const delvis = aktiv.currentMessage?.usage;
          forbrug.input += delvis?.input_tokens ?? 0;
          forbrug.cacheRead += delvis?.cache_read_input_tokens ?? 0;
          forbrug.cacheWrite += delvis?.cache_creation_input_tokens ?? 0;
          forbrug.output += skoenOutputTokens(delvis?.output_tokens ?? 0, rundeTegn);
        }
        aktiv = null;
        stop = tidenGik ? "tid" : err instanceof Anthropic.APIUserAbortError ? "afbrudt" : "fejl";
        medarbejder = true;
        if (!(err instanceof Anthropic.APIUserAbortError)) {
          console.error("BidHamr-bot fejlede:", err);
          await logDriftFejl({
            kilde: "server",
            sti: k.kilde === "app" ? "/api/app/bot" : "/api/bot",
            hvor: "BidHamr-bot: Claude API",
            fejl: err instanceof Anthropic.APIError ? `${err.status ?? ""} ${err.name}` : err,
            brugerId: k.brugerId,
          });
        }
        send({ type: "fejl", fejl: FEJL_TEKST });
        if (!tekst.trim()) tekst = FEJL_TEKST;
      }

      clearTimeout(timer);
      k.signal?.removeEventListener("abort", afbryd);
      if (medarbejder) send({ type: "medarbejder" });

      try {
        const { error: gemFejl } = await admin.rpc("bot_gem_svar", {
          p_samtale: samtaleId,
          p_tekst: tekst,
          p_model: model,
          p_input: forbrug.input,
          p_output: forbrug.output,
          p_cache_read: forbrug.cacheRead,
          p_cache_write: forbrug.cacheWrite,
          p_pris_usd: botPrisUsd(model, forbrug),
          p_vaerktoejer: brugte,
          p_stop: stop,
          p_runder: runder,
        });
        if (gemFejl) console.error("BidHamr-bot: svaret kunne ikke gemmes:", gemFejl.message);
      } catch (err) {
        console.error("BidHamr-bot: svaret kunne ikke gemmes:", err);
      }

      send({ type: "slut" });
      if (!lukket) {
        try {
          controller.close();
        } catch {
          // allerede lukket
        }
      }
    },
  });

  return { stream, samtaleId };
}

// Samtalen som tekst til henvendelsen i admin (højst 4.000 tegn - de nyeste
// beskeder bevares, hvis den er for lang). Hver linje, brugeren har skrevet,
// indrykkes med "> ", så en forfalsket "BidHamr-bot:"-linje i en besked
// aldrig kan stå alene. Den rigtige samtale står på /admin/bot/[id].
export function samtaleSomTekst(raekker: { rolle: string; tekst: string }[], maks = 4000): string {
  const linjer = raekker.map((r) =>
    r.rolle === "bruger"
      ? `Bruger:\n${r.tekst
          .trim()
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n")}`
      : `BidHamr-bot: ${r.tekst.trim()}`,
  );
  const hoved =
    "Samtale med BidHamr-bot (brugeren bad om en rigtig medarbejder). Brugerens tekst står efter \"> \". Den rigtige samtale står under Henvendelser -> BidHamr-bot.\n\n";
  let krop = linjer.join("\n\n");
  if (hoved.length + krop.length > maks) {
    const plads = maks - hoved.length - 30;
    krop = `[... tidligere beskeder udeladt]\n\n${krop.slice(krop.length - plads)}`;
  }
  return `${hoved}${krop}`.slice(0, maks);
}

// Samme mail til support som kontaktformularen. Må aldrig vælte svaret:
// henvendelsen er allerede gemt og står i /admin/kontakt.
async function mailTilSupport(henvendelseId: string | null, brugerId: string | null): Promise<void> {
  try {
    if (!henvendelseId) return;
    const { data: h } = await createAdminClient()
      .from("kontakt_henvendelser")
      .select("email, besked, oprettet_kl")
      .eq("id", henvendelseId)
      .maybeSingle<{ email: string; besked: string; oprettet_kl: string }>();
    if (!h) return;
    const resultat = await sendHandelMailDetaljer(
      SUPPORT_EMAIL,
      kontaktSupportMail({
        emne: "bot",
        besked: h.besked,
        email: h.email,
        handelsRef: null,
        tradeId: null,
        brugerId,
        tidspunkt: new Date(h.oprettet_kl),
      }),
    );
    if (!resultat.ok) {
      await logDriftFejl({ kilde: "server", sti: "/api/bot/medarbejder", hvor: "BidHamr-bot: mail til support", fejl: resultat.fejl, brugerId });
    }
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/bot/medarbejder", hvor: "BidHamr-bot: mail til support", fejl: err, brugerId });
  }
}

export type OverdragSvar = { ok: true; allerede: boolean } | { status: number; fejl: string; kode: string };

// "Kontakt en rigtig medarbejder": opretter henvendelsen i admin med hele
// samtalen. brugerId er den verificerede bruger; uden login kræves e-mail.
export async function overdragTilMedarbejder(o: {
  samtaleId: string;
  brugerId: string | null;
  email: string | null;
  ip: string;
}): Promise<OverdragSvar> {
  if (!botNoegle() || !botModel()) return BOT_IKKE_TILGAENGELIG;
  if (!o.brugerId && !o.email) {
    return { status: 400, fejl: "Skriv din e-mail, så en medarbejder kan svare dig.", kode: "mangler_email" };
  }
  const admin = createAdminClient();
  const hash = ipHash(o.ip || "ukendt");
  const { data: samtale } = await admin
    .from("bot_samtaler")
    .select("id, bruger_id, ip_hash, renset_kl")
    .eq("id", o.samtaleId)
    .maybeSingle<{ id: string; bruger_id: string | null; ip_hash: string | null; renset_kl: string | null }>();
  // Uden login: kun fra samme IP (/64) som samtalen. Databasen tjekker det igen.
  if (!samtale || samtale.bruger_id !== o.brugerId || samtale.renset_kl || (!o.brugerId && samtale.ip_hash !== hash)) {
    return { status: 404, fejl: "Samtalen findes ikke. Start en ny samtale.", kode: "ukendt_samtale" };
  }
  const { data: raekker, error: hentFejl } = await admin
    .from("bot_beskeder")
    .select("rolle, tekst")
    .eq("samtale_id", o.samtaleId)
    .order("oprettet_kl", { ascending: true })
    .limit(200);
  if (hentFejl) return { status: 500, fejl: "Noget gik galt. Prøv igen om lidt.", kode: "fejl" };

  const { data, error } = await admin.rpc("bot_overdrag", {
    p_samtale: o.samtaleId,
    p_bruger: o.brugerId,
    p_email: o.brugerId ? null : o.email,
    p_besked: samtaleSomTekst((raekker ?? []) as { rolle: string; tekst: string }[]),
    p_ip_hash: hash,
  });
  if (error) {
    await logDriftFejl({ kilde: "server", sti: "/api/bot/medarbejder", hvor: "bot_overdrag", fejl: error.message, brugerId: o.brugerId });
    return { status: 500, fejl: "Noget gik galt. Prøv igen om lidt.", kode: "fejl" };
  }
  const res = data as { kode?: string; henvendelse_id?: string } | null;
  const kode = res?.kode;
  if (kode === "ok") {
    await mailTilSupport(res?.henvendelse_id ?? null, o.brugerId);
    return { ok: true, allerede: false };
  }
  if (kode === "allerede") return { ok: true, allerede: true };
  if (kode === "ugyldig_email") return { status: 400, fejl: "Skriv en gyldig e-mailadresse.", kode };
  if (kode === "tom_samtale") return { status: 400, fejl: "Skriv først en besked til BidHamr-bot.", kode };
  if (kode === "ukendt_samtale") return { status: 404, fejl: "Samtalen findes ikke. Start en ny samtale.", kode };
  return { status: 500, fejl: "Noget gik galt. Prøv igen om lidt.", kode: "fejl" };
}
