import "server-only";

// Beskeder for Digital Services Act. Kaster ALDRIG.
//
// - Kvittering til anmelderen (art. 16(4)) - mail til den e-mail, anmelderen
//   har givet (eller kontoens). Claimes med kvittering_sendt_kl (højst én).
//   Viser aldrig fritekst fra anmelderen (kun et link, BidHamr selv har
//   bygget). Højst 3 kvitteringer pr. modtager pr. døgn og 100 i alt pr. time
//   uden login (e-mailen er ikke bekræftet) - over loftet sendes den ikke.
//
// Alle claims frigives igen, hvis afsendelsen fejler, så cron'en prøver igen.
// - Afgørelsen til anmelderen (art. 16(5)) - claimes med svar_sendt_kl.
// - Begrundelsen til den ramte bruger (art. 17) - type 'afgoerelse'
//   (påkrævet), mail sendes ALTID (også ved suspenderet/lukket konto, hvor
//   brugeren ikke kan logge ind). Nøgle dsa_afgoerelse:<id>.
// - Svar på en klage (art. 20) - claimes med svar_sendt_kl.
//
// Sendes med det samme efter handlingen (after()) og samles op af
// koerDsaNotifikationer() fra notifikations-cron'en, hvis det fejlede.
// Mails indeholder et signeret link (src/lib/dsa/link.ts). Klokke og push
// linker uden token (siden kræver så login som ejeren).
import { createAdminClient } from "@/lib/supabase/admin";
import { sendHandelMail } from "@/lib/mails/send";
import { send } from "@/lib/notifikationer/send";
import { afgoerelseSti, anmeldelseSti } from "@/lib/dsa/link";
import {
  afgoerelseMail,
  anmeldelseKvitteringMail,
  anmeldelseSvarMail,
  klageSvarMail,
} from "@/lib/mails/dsa";
import { HANDLING_BRUGER, type DsaHandling } from "@/lib/dsa/regler";
import { indenForGraense } from "@/lib/rateLimit";

type Admin = ReturnType<typeof createAdminClient>;

async function modtager(
  admin: Admin,
  brugerId: string | null,
  email: string | null,
): Promise<string | null> {
  if (email) return email;
  if (!brugerId) return null;
  const { data } = await admin
    .from("users")
    .select("email")
    .eq("id", brugerId)
    .maybeSingle<{ email: string | null }>();
  return data?.email ?? null;
}

// ------------------------------------------------------------------ Kvittering

export async function sendAnmeldelseKvittering(id: string): Promise<void> {
  try {
    const admin = createAdminClient();
    // Claim: højst én kvittering pr. anmeldelse.
    const { data } = await admin
      .from("dsa_anmeldelser")
      .update({ kvittering_sendt_kl: new Date().toISOString() })
      .eq("id", id)
      .is("kvittering_sendt_kl", null)
      .select("id, sagsnummer, indhold_type, kategori, placering, oprettet_kl, anmelder_id, anmelder_email")
      .maybeSingle<{
        id: string;
        sagsnummer: string;
        indhold_type: string;
        kategori: string;
        placering: string;
        oprettet_kl: string;
        anmelder_id: string | null;
        anmelder_email: string | null;
      }>();
    if (!data) return;
    const til = await modtager(admin, data.anmelder_id, data.anmelder_email);
    if (!til) return;
    // Lofter (se toppen). Over loftet: ingen mail, og claimet bliver stående,
    // så cron'en ikke prøver igen.
    const indenFor =
      (await indenForGraense("dsa_kvittering_email", til)) &&
      (!!data.anmelder_id || (await indenForGraense("dsa_kvittering_anonym", "alle")));
    if (!indenFor) {
      console.warn("DSA: kvittering ikke sendt (loft for kvitteringsmails nået):", data.sagsnummer);
      return;
    }
    const sendt = await sendHandelMail(
      til,
      anmeldelseKvitteringMail({
        sagsnummer: data.sagsnummer,
        indholdType: data.indhold_type,
        kategori: data.kategori,
        // Kun et link, BidHamr selv har bygget - aldrig fritekst.
        placering: data.indhold_type !== "andet" && data.placering.startsWith("/") ? data.placering : null,
        oprettet: data.oprettet_kl,
        statusSti: anmeldelseSti(data.id),
        haster: data.kategori === "misbrug_boern" || data.kategori === "hadefuld_tale",
      }),
    );
    if (!sendt) await frigiv(admin, "dsa_anmeldelser", "kvittering_sendt_kl", data.id);
  } catch (err) {
    console.error("DSA: kvittering fejlede:", err);
  }
}

// Frigiver et claim, så cron'en prøver igen.
async function frigiv(
  admin: Admin,
  tabel: "dsa_anmeldelser" | "dsa_klager",
  kolonne: "kvittering_sendt_kl" | "svar_sendt_kl",
  id: string,
): Promise<void> {
  const { error } = await admin.from(tabel).update({ [kolonne]: null }).eq("id", id);
  if (error) console.error("DSA: claim kunne ikke frigives:", tabel, kolonne, error.message);
}

// ------------------------------------------------------------------ Svar til anmelder

export async function notificerAnmeldelseSvar(id: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("dsa_anmeldelser")
      .update({ svar_sendt_kl: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "afgjort")
      .is("svar_sendt_kl", null)
      .select("id, sagsnummer, udfald, svar_til_anmelder, anmelder_id, anmelder_email, behandlet_kl")
      .maybeSingle<{
        id: string;
        sagsnummer: string;
        udfald: string;
        svar_til_anmelder: string | null;
        anmelder_id: string | null;
        anmelder_email: string | null;
        behandlet_kl: string;
      }>();
    if (!data) return;
    const { count } = await admin
      .from("dsa_klager")
      .select("id", { count: "exact", head: true })
      .eq("anmeldelse_id", data.id);
    const kanKlage = data.udfald !== "indgreb" && (count ?? 0) === 0;
    const mail = anmeldelseSvarMail({
      sagsnummer: data.sagsnummer,
      udfald: data.udfald,
      svar: data.svar_til_anmelder,
      statusSti: anmeldelseSti(data.id),
      kanKlage,
    });
    if (data.anmelder_id) {
      const r = await send(
        data.anmelder_id,
        "afgoerelse",
        {
          titel: "Svar på din anmeldelse",
          tekst: `Vi har behandlet din anmeldelse ${data.sagsnummer}. Se svaret.`,
          link: anmeldelseSti(data.id, false),
          data: { anmeldelse_id: data.id },
          mail,
          noegle: `dsa_anmeldelse_svar:${data.id}:${new Date(data.behandlet_kl).getTime()}`,
        },
        { altidMail: true },
      );
      if (!(r.klokke || r.mail || r.push || r.dublet)) await frigiv(admin, "dsa_anmeldelser", "svar_sendt_kl", data.id);
      return;
    }
    const til = await modtager(admin, null, data.anmelder_email);
    if (til && !(await sendHandelMail(til, mail))) await frigiv(admin, "dsa_anmeldelser", "svar_sendt_kl", data.id);
  } catch (err) {
    console.error("DSA: svar til anmelder fejlede:", err);
  }
}

// ------------------------------------------------------------------ Begrundelse (art. 17)

type AfgRaekke = {
  id: string;
  sagsnummer: string;
  bruger_id: string;
  handling: DsaHandling;
  indhold_tekst: string | null;
  regel_tekst: string;
  fakta: string;
  anmeldelse_id: string | null;
  automatisk_opdaget: boolean;
  varighed_til: string | null;
  oprettet_kl: string;
  klage_frist_kl: string;
};

export async function notificerAfgoerelse(id: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: a } = await admin
      .from("dsa_afgoerelser")
      .select(
        "id, sagsnummer, bruger_id, handling, indhold_tekst, regel_tekst, fakta, anmeldelse_id, automatisk_opdaget, varighed_til, oprettet_kl, klage_frist_kl",
      )
      .eq("id", id)
      .maybeSingle<AfgRaekke>();
    if (!a) return;
    const titel = HANDLING_BRUGER[a.handling] ?? "BidHamr har begrænset dit indhold";
    const r = await send(
      a.bruger_id,
      "afgoerelse",
      {
        titel,
        tekst: `${titel}. Begrundelse: ${a.fakta.slice(0, 300)}${a.fakta.length > 300 ? "…" : ""} Du kan klage inden for 6 måneder.`,
        link: afgoerelseSti(a.id, false),
        data: { afgoerelse_id: a.id },
        mail: afgoerelseMail({
          sagsnummer: a.sagsnummer,
          handling: a.handling,
          indholdTekst: a.indhold_tekst,
          regelTekst: a.regel_tekst,
          fakta: a.fakta,
          efterAnmeldelse: !!a.anmeldelse_id,
          automatiskOpdaget: a.automatisk_opdaget,
          varighedTil: a.varighed_til,
          oprettet: a.oprettet_kl,
          klageFrist: a.klage_frist_kl,
          sti: afgoerelseSti(a.id),
        }),
        noegle: `dsa_afgoerelse:${a.id}`,
      },
      { altidMail: true },
    );
    if (r.klokke || r.mail || r.push || r.dublet) {
      await admin
        .from("dsa_afgoerelser")
        .update({ notificeret_kl: new Date().toISOString() })
        .eq("id", a.id)
        .is("notificeret_kl", null);
    }
  } catch (err) {
    console.error("DSA: begrundelse til bruger fejlede:", err);
  }
}

// ------------------------------------------------------------------ Svar på klage

export async function notificerKlageSvar(id: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: k } = await admin
      .from("dsa_klager")
      .update({ svar_sendt_kl: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "afgjort")
      .is("svar_sendt_kl", null)
      .select("id, sagsnummer, afgoerelse_id, anmeldelse_id, klager_id, klager_email, udfald, svar")
      .maybeSingle<{
        id: string;
        sagsnummer: string;
        afgoerelse_id: string | null;
        anmeldelse_id: string | null;
        klager_id: string | null;
        klager_email: string | null;
        udfald: "medhold" | "fastholdt";
        svar: string;
      }>();
    if (!k) return;
    // Medhold i en klage over en fjernet/stoppet auktion: afgørelsen er
    // ophævet, men auktionen genåbnes aldrig (Filip, 6. okt. 2026) - sælgeren
    // kan sætte varen op igen med ét klik.
    let ikkeGenaabnet = false;
    if (k.udfald === "medhold" && k.afgoerelse_id) {
      const { data: af } = await admin
        .from("dsa_afgoerelser")
        .select("handling")
        .eq("id", k.afgoerelse_id)
        .maybeSingle<{ handling: string }>();
      ikkeGenaabnet = !!af && ["auktion_fjernet", "auktion_annulleret"].includes(af.handling);
    }
    const sti = k.afgoerelse_id ? afgoerelseSti(k.afgoerelse_id) : anmeldelseSti(k.anmeldelse_id!);
    const mail = klageSvarMail({ sagsnummer: k.sagsnummer, udfald: k.udfald, svar: k.svar, sti, ikkeGenaabnet });
    if (k.klager_id) {
      const r = await send(
        k.klager_id,
        "afgoerelse",
        {
          titel: k.udfald === "medhold" ? "Du har fået medhold i din klage" : "Vi har behandlet din klage",
          tekst: `Din klage ${k.sagsnummer} er behandlet af en anden medarbejder. Se svaret.`,
          link: k.afgoerelse_id ? afgoerelseSti(k.afgoerelse_id, false) : anmeldelseSti(k.anmeldelse_id!, false),
          data: { klage_id: k.id },
          mail,
          noegle: `dsa_klage_svar:${k.id}`,
        },
        { altidMail: true },
      );
      if (!(r.klokke || r.mail || r.push || r.dublet)) await frigiv(admin, "dsa_klager", "svar_sendt_kl", k.id);
      return;
    }
    if (k.klager_email && !(await sendHandelMail(k.klager_email, mail))) {
      await frigiv(admin, "dsa_klager", "svar_sendt_kl", k.id);
    }
  } catch (err) {
    console.error("DSA: svar på klage fejlede:", err);
  }
}

// ------------------------------------------------------------------ Cron

const MINUT = 60 * 1000;

// Samler op på beskeder, der ikke blev sendt med det samme (højst 7 dage
// tilbage). Rækker yngre end 2 minutter springes over - de sendes af after().
export async function koerDsaNotifikationer(): Promise<number> {
  let antal = 0;
  try {
    const admin = createAdminClient();
    const fra = new Date(Date.now() - 7 * 24 * 60 * MINUT).toISOString();
    const til = new Date(Date.now() - 2 * MINUT).toISOString();

    const [kv, sv, af, kl] = await Promise.all([
      admin.from("dsa_anmeldelser").select("id").is("kvittering_sendt_kl", null)
        .gte("oprettet_kl", fra).lte("oprettet_kl", til).limit(200),
      admin.from("dsa_anmeldelser").select("id").eq("status", "afgjort").is("svar_sendt_kl", null)
        .gte("behandlet_kl", fra).lte("behandlet_kl", til).limit(200),
      admin.from("dsa_afgoerelser").select("id").is("notificeret_kl", null)
        .gte("oprettet_kl", fra).lte("oprettet_kl", til).limit(200),
      admin.from("dsa_klager").select("id").eq("status", "afgjort").is("svar_sendt_kl", null)
        .gte("afgjort_kl", fra).lte("afgjort_kl", til).limit(200),
    ]);
    for (const r of kv.data ?? []) { await sendAnmeldelseKvittering(r.id as string); antal++; }
    for (const r of sv.data ?? []) { await notificerAnmeldelseSvar(r.id as string); antal++; }
    for (const r of af.data ?? []) { await notificerAfgoerelse(r.id as string); antal++; }
    for (const r of kl.data ?? []) { await notificerKlageSvar(r.id as string); antal++; }
  } catch (err) {
    console.error("DSA: cron fejlede:", err);
  }
  return antal;
}
