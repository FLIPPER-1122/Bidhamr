import "server-only";

// Én indgang til alle notifikationer: klokke (notifikationer-tabellen), mail
// og push (Expo). Brugerens kanalvalg pr. type afgør, hvad der sendes.
//
// Regler:
// - Kaster ALDRIG. En fejl i én kanal stopper ikke de andre, og handelsflowet
//   (cron, webhooks, server actions) mærker intet til en fejl her.
// - Idempotens: med en `noegle` claimes afsendelsen i notifikation_afsendelser
//   FØR noget sendes. Samme nøgle sendes aldrig to gange.
// - Påkrævede typer kan ikke ende med alle kanaler fra (databasen håndhæver
//   det også); er de det alligevel, bruges klokken.
import { createAdminClient } from "@/lib/supabase/admin";
import { sendHandelMailDetaljer, type Mail } from "@/lib/mails/send";
import { logDriftFejl, renFejltekst } from "@/lib/drift";
import { notifikationMail } from "@/lib/mails/handel";
import { sikkerSti } from "@/lib/sikkerSti";
import {
  type Kanaler,
  type NotifikationType,
  STANDARD_KANALER,
  erPaakraevet,
} from "@/lib/notifikationer/typer";

export type NotifikationInput = {
  titel: string;
  tekst: string;
  // Intern sti, fx `/mine-handler/<id>`. Ugyldige stier droppes.
  link?: string | null;
  // Gemmes i klokken og sendes med push - modtageren kan læse det. Må ALDRIG
  // indeholde en anden brugers id (fx byder, liker, følger). Kun id'er på
  // auktioner, handler, betalinger o.l., som modtageren selv har adgang til.
  data?: Record<string, unknown>;
  // Egen mailskabelon. Uden den bygges en simpel mail af titel/tekst/link.
  mail?: Mail;
  // Idempotensnøgle, fx `overbudt:<bud-id>`. Gemmes kun i
  // notifikation_afsendelser (service-role) - aldrig hos modtageren.
  noegle?: string;
};

export type SendResultat = {
  klokke: boolean;
  mail: boolean;
  push: boolean;
  dublet?: true;
  // Nøglen kunne ikke claimes (ukendt fejl), og intet blev sendt.
  sprunget?: true;
};

export type SendOptions = {
  // Til cron: kan nøglen ikke claimes af ukendt årsag (ikke dublet), sendes en
  // VALGFRI type ikke - ellers sendes samme hændelse igen ved hver kørsel, da
  // nøglen aldrig bliver gemt. Påkrævede typer sendes stadig (hellere to gange
  // end aldrig). Næste kørsel prøver igen.
  springOverVedClaimFejl?: boolean;
  // Push er allerede sendt af en anden kilde (edge function
  // notificer-foelgere for nye auktioner) - send kun klokke og mail.
  udenPush?: boolean;
};

const INGEN: SendResultat = { klokke: false, mail: false, push: false };

const EXPO_URL = "https://exp.host/--/api/v2/push/send";

type Admin = ReturnType<typeof createAdminClient>;

// Resultat for én kanal. "ingen" = intet at sende til (ingen e-mail, ingen
// push-token) - ikke en fejl. fejl er renset (src/lib/drift.ts).
type KanalStatus = { s: "sendt" | "fejl" | "ingen"; fejl?: string };
const SENDT: KanalStatus = { s: "sendt" };
const INGEN_MODTAGER: KanalStatus = { s: "ingen" };
const fejlet = (err: unknown): KanalStatus => ({ s: "fejl", fejl: renFejltekst(err, 300) });

async function claimNoegle(
  admin: Admin,
  noegle: string,
  brugerId: string,
  type: NotifikationType,
): Promise<"ok" | "dublet" | "fejl"> {
  const raekke = { noegle: noegle.slice(0, 300), bruger_id: brugerId, type };
  // status = 'claimet', til afsendelsen er meldt færdig (se meldStatus).
  let { error } = await admin
    .from("notifikation_afsendelser")
    .insert({ ...raekke, status: "claimet" });
  // Migrationen 20261005060000 er ikke kørt endnu: claim uden status.
  if (error && (error.code === "PGRST204" || error.code === "42703")) {
    ({ error } = await admin.from("notifikation_afsendelser").insert(raekke));
  }
  if (!error) return "ok";
  if (error.code === "23505") return "dublet";
  // Ukendt fejl (fx databasen svarer ikke). send() afgør, om der alligevel
  // sendes (se SendOptions.springOverVedClaimFejl).
  console.error("Notifikation: claim af nøgle fejlede:", noegle, error.message);
  return "fejl";
}

export async function hentKanaler(
  admin: Admin,
  brugerId: string,
  type: NotifikationType,
): Promise<Kanaler> {
  const { data, error } = await admin
    .from("notifikation_indstillinger")
    .select("klokke, mail, push")
    .eq("bruger_id", brugerId)
    .eq("type", type)
    .maybeSingle<Kanaler>();
  if (error) console.error("Notifikation: indstillinger kunne ikke hentes:", error.message);
  const k = data ?? STANDARD_KANALER;
  if (erPaakraevet(type) && !k.klokke && !k.mail && !k.push) {
    return { klokke: true, mail: false, push: false };
  }
  return k;
}

async function gemIKlokke(
  admin: Admin,
  brugerId: string,
  type: NotifikationType,
  input: NotifikationInput,
  link: string | null,
): Promise<KanalStatus> {
  const { error } = await admin.from("notifikationer").insert({
    bruger_id: brugerId,
    type,
    titel: input.titel.slice(0, 200),
    tekst: input.tekst.slice(0, 2000),
    link,
    // Kun input.data - aldrig nøglen: den kan indeholde andre brugeres id
    // (fx likerens), og modtageren kan læse sin egen klokke-række.
    data: input.data ?? {},
  });
  if (error) {
    console.error("Notifikation: klokke fejlede:", type, error.message);
    return fejlet(error);
  }
  return SENDT;
}

async function sendMailTil(
  admin: Admin,
  brugerId: string,
  input: NotifikationInput,
  link: string | null,
): Promise<KanalStatus> {
  const { data: u, error } = await admin
    .from("users")
    .select("email")
    .eq("id", brugerId)
    .maybeSingle<{ email: string | null }>();
  if (error) {
    console.error("Notifikation: email kunne ikke hentes:", error.message);
    return fejlet(error);
  }
  if (!u?.email) return INGEN_MODTAGER;
  const r = await sendHandelMailDetaljer(
    u.email,
    input.mail ?? notifikationMail(input.titel, input.tekst, link),
  );
  return r.ok ? SENDT : fejlet(r.fejl);
}

const EXPO_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/;

type ExpoTicket = {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
};

export async function sendPushTil(
  admin: Admin,
  brugerId: string,
  type: NotifikationType,
  input: NotifikationInput,
  link: string | null,
): Promise<boolean> {
  return (await pushTil(admin, brugerId, type, input, link)).s === "sendt";
}

async function pushTil(
  admin: Admin,
  brugerId: string,
  type: NotifikationType,
  input: NotifikationInput,
  link: string | null,
): Promise<KanalStatus> {
  const { data: tokens, error } = await admin
    .from("push_tokens")
    .select("token")
    .eq("user_id", brugerId);
  if (error) {
    console.error("Notifikation: push tokens kunne ikke hentes:", error.message);
    return fejlet(error);
  }
  // Tabellen har ingen formatkrav (appen skriver selv i den, og platform kan
  // være 'web'). Expo accepterer kun Expo-tokens, så resten springes over.
  const liste = (tokens ?? [])
    .map((t) => t.token as string)
    .filter((t) => typeof t === "string" && EXPO_TOKEN.test(t));
  if (liste.length === 0) return INGEN_MODTAGER;

  const beskeder = liste.map((to) => ({
    to,
    title: input.titel.slice(0, 200),
    body: input.tekst.slice(0, 500),
    sound: "default",
    // Appen bruger link til at åbne den rigtige skærm.
    data: { type, link, ...(input.data ?? {}) },
  }));

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (process.env.EXPO_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  }

  let enSendt = false;
  // Sidste fejl (kode, aldrig token), hvis ingen blev sendt.
  let sidsteFejl: string | null = null;
  let kunDoede = true;
  // Expo tager højst 100 beskeder pr. kald.
  for (let i = 0; i < beskeder.length; i += 100) {
    const del = beskeder.slice(i, i + 100);
    try {
      const svar = await fetch(EXPO_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(del),
        signal: AbortSignal.timeout(10_000),
      });
      if (!svar.ok) {
        console.error("Notifikation: Expo svarede", svar.status);
        sidsteFejl = `Expo svarede ${svar.status}`;
        kunDoede = false;
        continue;
      }
      const json = (await svar.json()) as { data?: ExpoTicket[] };
      const tickets = json.data ?? [];
      const doede: string[] = [];
      tickets.forEach((t, idx) => {
        if (t.status === "ok") enSendt = true;
        else if (t.details?.error === "DeviceNotRegistered") doede.push(del[idx].to);
        else {
          console.warn("Notifikation: push afvist:", t.details?.error ?? t.message);
          sidsteFejl = `Push afvist: ${t.details?.error ?? t.message ?? "ukendt"}`;
          kunDoede = false;
        }
      });
      if (doede.length > 0) {
        const { error: sletFejl } = await admin.from("push_tokens").delete().in("token", doede);
        if (sletFejl) console.error("Notifikation: døde tokens kunne ikke fjernes:", sletFejl.message);
      }
    } catch (err) {
      console.error("Notifikation: push kastede:", err);
      sidsteFejl = renFejltekst(err, 300);
      kunDoede = false;
    }
  }
  if (enSendt) return SENDT;
  // Kun afmeldte enheder (DeviceNotRegistered): ingen modtager, ikke en fejl.
  if (kunDoede) return INGEN_MODTAGER;
  return fejlet(sidsteFejl ?? "Push blev ikke sendt");
}

// Samlet status for afsendelsen (se migration 20261005060000).
function samletStatus(k: Record<"klokke" | "mail" | "push", KanalStatus | null>) {
  const alle = Object.values(k).filter((v): v is KanalStatus => v !== null);
  const sendt = alle.some((v) => v.s === "sendt");
  const fejl = alle.some((v) => v.s === "fejl");
  if (sendt && fejl) return "delvis" as const;
  if (fejl) return "fejlet" as const;
  if (sendt) return "sendt" as const;
  return "ingen_kanal" as const;
}

function fejlTekst(k: Record<"klokke" | "mail" | "push", KanalStatus | null>): string | null {
  const dele = (Object.entries(k) as [string, KanalStatus | null][])
    .filter(([, v]) => v?.s === "fejl")
    .map(([navn, v]) => `${navn}: ${v?.fejl ?? "ukendt fejl"}`);
  return dele.length > 0 ? dele.join(" | ").slice(0, 1000) : null;
}

// Melder afsendelsen færdig på den claimede nøgle, eller logger fejlede
// kanaler i drift_fejl, hvis der ingen nøgle er. Kaster aldrig.
async function meldStatus(
  admin: Admin,
  noegle: string | undefined,
  brugerId: string,
  type: NotifikationType,
  k: Record<"klokke" | "mail" | "push", KanalStatus | null>,
) {
  try {
    const status = samletStatus(k);
    const fejl = fejlTekst(k);
    if (noegle) {
      const kanaler = Object.fromEntries(
        Object.entries(k).map(([navn, v]) => [navn, v === null ? "fra" : v.s]),
      );
      const { error } = await admin
        .from("notifikation_afsendelser")
        .update({ status, afsluttet_kl: new Date().toISOString(), kanaler, fejl })
        .eq("noegle", noegle.slice(0, 300))
        .eq("status", "claimet");
      // PGRST204/42703: migrationen er ikke kørt - intet at melde.
      if (error && error.code !== "PGRST204" && error.code !== "42703") {
        console.error("Notifikation: status kunne ikke gemmes:", error.message);
      }
    } else if (fejl) {
      await logDriftFejl({
        kilde: "notifikation",
        sti: `notifikation:${type}`,
        fejl,
        brugerId,
      });
    }
  } catch (err) {
    console.error("Notifikation: status kastede:", err);
  }
}

// Sender en notifikation til én bruger. Kaster aldrig.
export async function send(
  brugerId: string | null | undefined,
  type: NotifikationType,
  input: NotifikationInput,
  opts: SendOptions = {},
): Promise<SendResultat> {
  if (!brugerId) return INGEN;
  try {
    const admin = createAdminClient();
    if (input.noegle) {
      const claim = await claimNoegle(admin, input.noegle, brugerId, type);
      if (claim === "dublet") return { ...INGEN, dublet: true };
      // Ukendt fejl: påkrævede typer sendes alligevel (hellere sende end tabe
      // beskeden - kilderne har egne claims på de vigtige mails). Valgfrie
      // typer fra cron springes over, så de ikke sendes ved hver kørsel.
      if (claim === "fejl" && opts.springOverVedClaimFejl && !erPaakraevet(type)) {
        return { ...INGEN, sprunget: true };
      }
    }
    const link = input.link ? sikkerSti(input.link, "") || null : null;
    const kanaler = await hentKanaler(admin, brugerId, type);

    const fra = Promise.resolve(null);
    const [klokke, mail, push] = await Promise.allSettled([
      kanaler.klokke ? gemIKlokke(admin, brugerId, type, input, link) : fra,
      kanaler.mail ? sendMailTil(admin, brugerId, input, link) : fra,
      kanaler.push && !opts.udenPush ? pushTil(admin, brugerId, type, input, link) : fra,
    ]);
    // null = kanalen er fra.
    const status = (r: PromiseSettledResult<KanalStatus | null>): KanalStatus | null => {
      if (r.status === "fulfilled") return r.value;
      console.error("Notifikation: kanal kastede:", type, r.reason);
      return fejlet(r.reason);
    };
    const k = { klokke: status(klokke), mail: status(mail), push: status(push) };
    await meldStatus(admin, input.noegle, brugerId, type, k);
    const ok = (v: KanalStatus | null) => v?.s === "sendt";
    return { klokke: ok(k.klokke), mail: ok(k.mail), push: ok(k.push) };
  } catch (err) {
    console.error("Notifikation: send kastede:", type, err);
    return INGEN;
  }
}
