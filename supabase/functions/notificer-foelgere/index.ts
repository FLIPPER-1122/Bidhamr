// Sender en push-notifikation til en sælgers følgere, når sælgeren har
// oprettet en ny auktion. Kaldes fra Expo-appen lige efter auktionen er indsat.
//
// Indfanget fra produktion (version 1) og rettet i sikkerhedsgennemgangen
// (M2, okt. 2026). IKKE DEPLOYET - Filip deployer selv:
//   supabase functions deploy notificer-foelgere --project-ref <ref>
//
// Regler:
// - Kalderen skal være logget ind (Authorization: Bearer <access token>), og
//   auktionen skal være hans egen. Tidligere kunne hvem som helst med anon-
//   nøglen sende push til en vilkårlig sælgers følgere, igen og igen.
// - Kun aktive, ikke-skjulte auktioner oprettet inden for de sidste 10 minutter.
// - Hver følger får højst én push pr. auktion: nøglen
//   ny_auktion_push:<auktion>:<følger> claimes i notifikation_afsendelser, før
//   der sendes. Hjemmesidens cron (src/lib/notifikationer/cron.ts,
//   nyAuktionFraFulgt) ser nøglen og sender så kun klokke og mail - ikke push
//   en gang til. Omvendt: har cron'en allerede claimet sin nøgle
//   ny_auktion:<auktion>:<følger> (og dermed sendt push), sender vi ikke.
//   Kører de to helt samtidig, kan der stadig komme én dobbelt push (sjældent;
//   cron'en kører hvert minut, appen kalder lige efter oprettelsen).
// - Samme filtre som cron'en: følgningen skal være ældre end auktionen,
//   blokeringer respekteres (sælger har blokeret følgeren - også anonymt;
//   følgeren har blokeret sælgeren navngivet), og følgerens indstilling for
//   push på typen ny_auktion_fulgt_saelger respekteres (standard: til).
// - Svaret afslører intet: ingen fejltekster, intet antal følgere/enheder.
//
// Kører med service_role, så den kan læse følgernes push-tokens - dem må
// ingen klient selv hente.

import { createClient } from "jsr:@supabase/supabase-js@2";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const TYPE = "ny_auktion_fulgt_saelger";
const MAKS_ALDER_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPO_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function svar(krop: unknown, status = 200) {
  return new Response(JSON.stringify(krop), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Samme svar, uanset om der blev sendt noget, så kalderen intet lærer.
const OK = () => svar({ ok: true });

type Afsendelse = { noegle: string; follower: string; tokens: string[] };

// Den hemmelige nøgle. Supabase giver selv funktionen SUPABASE_SECRET_KEYS
// (JSON med de nye sb_secret_-nøgler efter navn; "default" er standard) og den
// gamle SUPABASE_SERVICE_ROLE_KEY. Den nye bruges, hvis den findes, så
// funktionen virker videre, når de gamle nøgler slås fra.
// verify_jwt er slået fra i supabase/config.toml: funktionen tjekker selv
// kalderens access token hos Supabase Auth (getUser herunder).
function hemmeligNoegle(): string {
  try {
    const nye = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (typeof nye?.default === "string" && nye.default) return nye.default;
  } catch {
    // ugyldig JSON - brug den gamle nøgle
  }
  const gammel = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!gammel) throw new Error("Ingen hemmelig nøgle i miljøet");
  return gammel;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return svar({ error: "Ugyldig forespørgsel" }, 405);

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return svar({ error: "Ikke logget ind" }, 401);

    let auktionId: unknown;
    try {
      ({ auktion_id: auktionId } = await req.json());
    } catch {
      return svar({ error: "Ugyldig forespørgsel" }, 400);
    }
    if (typeof auktionId !== "string" || !UUID.test(auktionId)) {
      return svar({ error: "Ugyldig forespørgsel" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      hemmeligNoegle(),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // Kalderen valideres af Supabase Auth (ikke kun JWT-signaturen).
    const { data: brugerData, error: brugerFejl } = await supabase.auth.getUser(token);
    const bruger = brugerData?.user;
    if (brugerFejl || !bruger) return svar({ error: "Ikke logget ind" }, 401);

    // Auktionen bestemmer afsender og tekst - intet fra klienten bruges.
    const { data: auktion } = await supabase
      .from("auctions")
      .select("id, titel, bruger_id, status, skjult, oprettet")
      .eq("id", auktionId)
      .maybeSingle();

    if (!auktion || auktion.bruger_id !== bruger.id) {
      return svar({ error: "Ingen adgang" }, 403);
    }
    const oprettet = new Date(auktion.oprettet as string);
    if (
      auktion.status !== "aktiv" ||
      auktion.skjult === true ||
      Number.isNaN(oprettet.getTime()) ||
      Date.now() - oprettet.getTime() > MAKS_ALDER_MS
    ) {
      return OK();
    }

    const { data: saelger } = await supabase
      .from("users")
      .select("navn")
      .eq("id", auktion.bruger_id)
      .maybeSingle();

    const { data: foelgere, error: foelgFejl } = await supabase
      .from("seller_follows")
      .select("follower_id, created_at")
      .eq("seller_id", auktion.bruger_id)
      .lte("created_at", auktion.oprettet)
      .limit(5000);
    if (foelgFejl) {
      console.error("[notificer-foelgere] følgere:", foelgFejl.message);
      return OK();
    }
    const foelgerIds = [...new Set((foelgere ?? []).map((f) => f.follower_id as string))];
    if (foelgerIds.length === 0) return OK();

    // Blokeringer (samme regel som cron'en). Fejl = ingen beskeder.
    const blokeret = new Set<string>();
    for (const [kolonne, modsat] of [
      ["blokerer_id", "blokeret_id"],
      ["blokeret_id", "blokerer_id"],
    ] as const) {
      const { data: blok, error } = await supabase
        .from("brugerblokeringer")
        .select("blokerer_id, blokeret_id, kilde_auktion_id")
        .eq(kolonne, auktion.bruger_id)
        .limit(10000);
      if (error) {
        console.error("[notificer-foelgere] blokeringer:", error.message);
        return OK();
      }
      for (const b of blok ?? []) {
        const anden = b[modsat] as string;
        // Sælgeren har blokeret følgeren: altid. Følgeren har blokeret
        // sælgeren: kun navngivet (kilde_auktion_id er null).
        if (kolonne === "blokerer_id" || b.kilde_auktion_id == null) blokeret.add(anden);
      }
    }

    const modtagere = foelgerIds.filter((id) => !blokeret.has(id));
    if (modtagere.length === 0) return OK();

    // Følgere, der har slået push fra for typen.
    const pushFra = new Set<string>();
    for (let i = 0; i < modtagere.length; i += 200) {
      const { data: ind, error } = await supabase
        .from("notifikation_indstillinger")
        .select("bruger_id, push")
        .eq("type", TYPE)
        .in("bruger_id", modtagere.slice(i, i + 200));
      if (error) {
        console.error("[notificer-foelgere] indstillinger:", error.message);
        return OK();
      }
      for (const r of ind ?? []) if (r.push === false) pushFra.add(r.bruger_id as string);
    }
    const medPush = modtagere.filter((id) => !pushFra.has(id));
    if (medPush.length === 0) return OK();

    const tokensPr = new Map<string, string[]>();
    for (let i = 0; i < medPush.length; i += 200) {
      const { data: tokens, error } = await supabase
        .from("push_tokens")
        .select("user_id, token")
        .in("user_id", medPush.slice(i, i + 200));
      if (error) {
        console.error("[notificer-foelgere] tokens:", error.message);
        return OK();
      }
      for (const t of tokens ?? []) {
        if (typeof t.token !== "string" || !EXPO_TOKEN.test(t.token)) continue;
        const liste = tokensPr.get(t.user_id as string) ?? [];
        liste.push(t.token);
        tokensPr.set(t.user_id as string, liste);
      }
    }

    // Har hjemmesidens cron allerede taget følgeren (nøglen
    // ny_auktion:<auktion>:<følger>), har den også sendt push (den så ingen
    // push-nøgle fra os) - så sendes der ikke en gang til herfra.
    const cronTaget = new Set<string>();
    const foelgereMedToken = [...tokensPr.keys()];
    for (let i = 0; i < foelgereMedToken.length; i += 200) {
      const noegler = foelgereMedToken
        .slice(i, i + 200)
        .map((f) => `ny_auktion:${auktion.id}:${f}`);
      const { data, error } = await supabase
        .from("notifikation_afsendelser")
        .select("noegle")
        .in("noegle", noegler);
      if (error) {
        console.error("[notificer-foelgere] opslag af cron-nøgler:", error.message);
        return OK();
      }
      for (const r of data ?? []) cronTaget.add(r.noegle as string);
    }

    // Claim én nøgle pr. følger, FØR der sendes. 23505 = allerede sendt.
    const afsendelser: Afsendelse[] = [];
    for (const [follower, tokens] of tokensPr) {
      if (cronTaget.has(`ny_auktion:${auktion.id}:${follower}`)) continue;
      const noegle = `ny_auktion_push:${auktion.id}:${follower}`;
      const { error } = await supabase
        .from("notifikation_afsendelser")
        .insert({ noegle, bruger_id: follower, type: TYPE, status: "claimet" });
      if (error) {
        if (error.code !== "23505") console.error("[notificer-foelgere] claim:", error.message);
        continue;
      }
      afsendelser.push({ noegle, follower, tokens });
    }
    if (afsendelser.length === 0) return OK();

    const titel = "Ny auktion fra en sælger, du følger";
    const navn = (saelger?.navn as string | null)?.trim();
    const tekst = `${navn ? `${navn}: ` : ""}"${auktion.titel}" er lige sat på auktion.`.slice(0, 500);
    const link = `/auktion/${auktion.id}`;

    const beskeder = afsendelser.flatMap((a) =>
      a.tokens.map((to) => ({
        to,
        sound: "default",
        title: titel,
        body: tekst,
        // Samme form som hjemmesidens push (src/lib/notifikationer/send.ts).
        data: { type: TYPE, link, auction_id: auktion.id, auktion_id: auktion.id },
        _noegle: a.noegle,
      })),
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const expoToken = Deno.env.get("EXPO_ACCESS_TOKEN");
    if (expoToken) headers.Authorization = `Bearer ${expoToken}`;

    const sendt = new Set<string>();
    const doede: string[] = [];
    // Expo tager imod 100 beskeder ad gangen.
    for (let i = 0; i < beskeder.length; i += 100) {
      const del = beskeder.slice(i, i + 100);
      try {
        const res = await fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(del.map(({ _noegle: _, ...b }) => b)),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          console.error("[notificer-foelgere] Expo svarede", res.status);
          continue;
        }
        const krop = await res.json();
        // deno-lint-ignore no-explicit-any
        (krop?.data ?? []).forEach((r: any, n: number) => {
          if (r?.status === "ok") sendt.add(del[n]._noegle);
          else if (r?.details?.error === "DeviceNotRegistered") doede.push(del[n].to);
        });
      } catch (e) {
        console.error("[notificer-foelgere] push kastede", e instanceof Error ? e.message : "ukendt");
      }
    }

    // Døde tokens ryddes væk, så listen ikke vokser med ubrugelige tokens.
    if (doede.length > 0) {
      await supabase.from("push_tokens").delete().in("token", doede);
    }

    // Meld status på de claimede nøgler (samme felter som send.ts).
    const nu = new Date().toISOString();
    for (const a of afsendelser) {
      const ok = sendt.has(a.noegle);
      await supabase
        .from("notifikation_afsendelser")
        .update({
          status: ok ? "sendt" : "fejlet",
          afsluttet_kl: nu,
          kanaler: { klokke: "fra", mail: "fra", push: ok ? "sendt" : "fejl" },
          fejl: ok ? null : "push: ikke sendt (notificer-foelgere)",
        })
        .eq("noegle", a.noegle)
        .eq("status", "claimet");
    }

    return OK();
  } catch (e) {
    console.error("[notificer-foelgere] uventet fejl", e instanceof Error ? e.message : "ukendt");
    return svar({ error: "Der skete en fejl" }, 500);
  }
});
