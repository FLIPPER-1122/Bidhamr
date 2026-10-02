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
import { sendHandelMail, type Mail } from "@/lib/mails/send";
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
  data?: Record<string, unknown>;
  // Egen mailskabelon. Uden den bygges en simpel mail af titel/tekst/link.
  mail?: Mail;
  // Idempotensnøgle, fx `overbudt:<bud-id>:<bruger-id>`.
  noegle?: string;
};

export type SendResultat = {
  klokke: boolean;
  mail: boolean;
  push: boolean;
  dublet?: true;
};

const INGEN: SendResultat = { klokke: false, mail: false, push: false };

const EXPO_URL = "https://exp.host/--/api/v2/push/send";

type Admin = ReturnType<typeof createAdminClient>;

async function claimNoegle(
  admin: Admin,
  noegle: string,
  brugerId: string,
  type: NotifikationType,
): Promise<"ok" | "dublet"> {
  const { error } = await admin
    .from("notifikation_afsendelser")
    .insert({ noegle: noegle.slice(0, 300), bruger_id: brugerId, type });
  if (!error) return "ok";
  if (error.code === "23505") return "dublet";
  // Ukendt fejl (fx databasen svarer ikke): hellere sende end tabe en
  // påkrævet besked. Kilderne har i forvejen egne claims på de vigtige mails.
  console.error("Notifikation: claim af nøgle fejlede:", noegle, error.message);
  return "ok";
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
): Promise<boolean> {
  const { error } = await admin.from("notifikationer").insert({
    bruger_id: brugerId,
    type,
    titel: input.titel.slice(0, 200),
    tekst: input.tekst.slice(0, 2000),
    link,
    data: { ...(input.data ?? {}), ...(input.noegle ? { noegle: input.noegle } : {}) },
  });
  if (error) {
    console.error("Notifikation: klokke fejlede:", type, error.message);
    return false;
  }
  return true;
}

async function sendMailTil(
  admin: Admin,
  brugerId: string,
  input: NotifikationInput,
  link: string | null,
): Promise<boolean> {
  const { data: u, error } = await admin
    .from("users")
    .select("email")
    .eq("id", brugerId)
    .maybeSingle<{ email: string | null }>();
  if (error) {
    console.error("Notifikation: email kunne ikke hentes:", error.message);
    return false;
  }
  if (!u?.email) return false;
  return sendHandelMail(u.email, input.mail ?? notifikationMail(input.titel, input.tekst, link));
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
  const { data: tokens, error } = await admin
    .from("push_tokens")
    .select("token")
    .eq("user_id", brugerId);
  if (error) {
    console.error("Notifikation: push tokens kunne ikke hentes:", error.message);
    return false;
  }
  // Tabellen har ingen formatkrav (appen skriver selv i den, og platform kan
  // være 'web'). Expo accepterer kun Expo-tokens, så resten springes over.
  const liste = (tokens ?? [])
    .map((t) => t.token as string)
    .filter((t) => typeof t === "string" && EXPO_TOKEN.test(t));
  if (liste.length === 0) return false;

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
        continue;
      }
      const json = (await svar.json()) as { data?: ExpoTicket[] };
      const tickets = json.data ?? [];
      const doede: string[] = [];
      tickets.forEach((t, idx) => {
        if (t.status === "ok") enSendt = true;
        else if (t.details?.error === "DeviceNotRegistered") doede.push(del[idx].to);
        else console.warn("Notifikation: push afvist:", t.details?.error ?? t.message);
      });
      if (doede.length > 0) {
        const { error: sletFejl } = await admin.from("push_tokens").delete().in("token", doede);
        if (sletFejl) console.error("Notifikation: døde tokens kunne ikke fjernes:", sletFejl.message);
      }
    } catch (err) {
      console.error("Notifikation: push kastede:", err);
    }
  }
  return enSendt;
}

// Sender en notifikation til én bruger. Kaster aldrig.
export async function send(
  brugerId: string | null | undefined,
  type: NotifikationType,
  input: NotifikationInput,
): Promise<SendResultat> {
  if (!brugerId) return INGEN;
  try {
    const admin = createAdminClient();
    if (input.noegle && (await claimNoegle(admin, input.noegle, brugerId, type)) === "dublet") {
      return { ...INGEN, dublet: true };
    }
    const link = input.link ? sikkerSti(input.link, "") || null : null;
    const kanaler = await hentKanaler(admin, brugerId, type);

    const [klokke, mail, push] = await Promise.allSettled([
      kanaler.klokke ? gemIKlokke(admin, brugerId, type, input, link) : Promise.resolve(false),
      kanaler.mail ? sendMailTil(admin, brugerId, input, link) : Promise.resolve(false),
      kanaler.push ? sendPushTil(admin, brugerId, type, input, link) : Promise.resolve(false),
    ]);
    const ok = (r: PromiseSettledResult<boolean>) => r.status === "fulfilled" && r.value;
    for (const r of [klokke, mail, push]) {
      if (r.status === "rejected") console.error("Notifikation: kanal kastede:", type, r.reason);
    }
    return { klokke: ok(klokke), mail: ok(mail), push: ok(push) };
  } catch (err) {
    console.error("Notifikation: send kastede:", type, err);
    return INGEN;
  }
}
