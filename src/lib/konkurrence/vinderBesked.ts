import "server-only";

// Besked til vinderen af den månedlige lodtrækning (Filip, 15. okt. 2026):
// så snart der er trukket lod (konkurrence_traek / konkurrence_traek_igen),
// får vinderen
//   1. en samtale med BidHamr (staff-chat, sag_type 'konkurrence', sag_id =
//      trækningen), hvor vinderen svarer - åbnet i chefens navn, så den står
//      under Admin → Chats og i moderation_log,
//   2. en notifikation (klokke + push) og en mail (altid, uanset
//      notifikationsindstillinger) med svarfristen på 14 dage og et link til
//      samtalen. Typen er 'sag' (påkrævet: "når BidHamr åbner en samtale med
//      dig"), så appen kender den allerede.
//
// Idempotent - præcis én besked pr. vinder (pr. trækning):
//   - samtalen: findes der allerede en samtale om trækningen, genbruges den,
//     og der skrives ikke igen,
//   - notifikation og mail: nøglen konkurrence_vinder:<trækning> claimes i
//     notifikation_afsendelser, før noget sendes (send() i
//     src/lib/notifikationer/send.ts) - samme nøgle sendes aldrig to gange.
// Ingen vinder (ingen deltagere = ingen trækning) eller en erstattet
// trækning: intet sendes.
//
// Kaster aldrig: trækningen er allerede gemt, så en fejl her må ikke ligne en
// fejlet trækning. Fejl logges i drift, og chefen kan sende igen fra Admin →
// Konkurrence (samme idempotens).
import type { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { send } from "@/lib/notifikationer/send";
import { mailTidspunkt } from "@/lib/mails/konto";
import { konkurrenceVinderMail } from "@/lib/mails/konkurrence";
import { staffSamtaleSti } from "@/lib/staffChat";
import { SVARFRIST_DAGE } from "@/lib/konkurrence/regler";
import { KONKURRENCE_VINDER } from "@/lib/tekster/konkurrence";

type Admin = ReturnType<typeof createAdminClient>;

// staff_samtaler.sag_type for samtalen med vinderen.
export const KONKURRENCE_CHAT_TYPE = "konkurrence";

export type VinderBeskedSvar =
  | { status: "sendt"; samtaleId: string | null; mail: boolean; klokke: boolean }
  | { status: "allerede"; samtaleId: string | null }
  | { status: "ingen_vinder" }
  | { status: "fejl" };

// Svarfristen: 14 dage efter trækningen (samme som databasen:
// trukket_kl + make_interval(days => konkurrence_svarfrist_dage())).
export function svarfrist(trukketKl: string | Date): Date {
  return new Date(new Date(trukketKl).getTime() + SVARFRIST_DAGE * 24 * 60 * 60 * 1000);
}

type Traekning = { id: string; maaned: string; vinder_id: string | null; trukket_kl: string; erstattet_kl: string | null };

// Samtalen med vinderen om trækningen (åben eller lukket), hvis den findes.
export async function vinderSamtale(admin: Admin, traekningId: string): Promise<string | null | "fejl"> {
  const { data, error } = await admin
    .from("staff_samtaler")
    .select("id")
    .eq("sag_type", KONKURRENCE_CHAT_TYPE)
    .eq("sag_id", traekningId)
    .order("aabnet_kl", { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (error) return "fejl";
  return data?.id ?? null;
}

export async function giVinderBesked(admin: Admin, chefId: string, traekningId: string): Promise<VinderBeskedSvar> {
  const fejl = async (hvad: string, err: unknown): Promise<VinderBeskedSvar> => {
    await logDriftFejl({
      kilde: "server",
      sti: "/admin/konkurrence",
      hvor: `Konkurrence: besked til vinderen (${hvad})`,
      fejl: err,
    });
    return { status: "fejl" };
  };

  try {
    const { data: t, error } = await admin
      .from("konkurrence_traekninger")
      .select("id, maaned, vinder_id, trukket_kl, erstattet_kl")
      .eq("id", traekningId)
      .maybeSingle<Traekning>();
    if (error) return await fejl("trækningen", error);
    // Ingen vinder eller en vinder, der allerede er erstattet: ingen besked.
    if (!t || !t.vinder_id || t.erstattet_kl) return { status: "ingen_vinder" };

    const frist = mailTidspunkt(svarfrist(t.trukket_kl));

    // 1. Samtalen, hvor vinderen svarer (kun én pr. trækning).
    let samtaleId: string | null = null;
    const fundet = await vinderSamtale(admin, t.id);
    if (fundet === "fejl") return await fejl("samtale-opslag", "staff_samtaler kunne ikke læses");
    if (fundet) {
      samtaleId = fundet;
    } else {
      const { data: aabn, error: aFejl } = await admin.rpc("staff_chat_aabn", {
        p_medarbejder: chefId,
        p_bruger: t.vinder_id,
        p_emne: KONKURRENCE_VINDER.emne(t.maaned),
        p_trade: null,
        p_sag_type: KONKURRENCE_CHAT_TYPE,
        p_sag_id: t.id,
        p_besked: KONKURRENCE_VINDER.chat(t.maaned, frist),
      });
      const svar = aabn as { kode?: string; samtale_id?: string } | null;
      if (!aFejl && (svar?.kode === "ok" || svar?.kode === "findes") && svar.samtale_id) {
        samtaleId = svar.samtale_id;
      } else {
        // Uden samtale får vinderen stadig besked - og svarer på mail.
        await logDriftFejl({
          kilde: "server",
          sti: "/admin/konkurrence",
          hvor: "Konkurrence: samtale med vinderen kunne ikke åbnes",
          fejl: aFejl ?? `staff_chat_aabn: ${svar?.kode ?? "intet svar"}`,
        });
      }
    }

    // 2. Notifikation og mail - præcis én gang pr. trækning.
    const link = samtaleId ? staffSamtaleSti(samtaleId) : "/kontakt";
    const r = await send(
      t.vinder_id,
      "sag",
      {
        titel: KONKURRENCE_VINDER.titel,
        tekst: samtaleId
          ? KONKURRENCE_VINDER.notifikation(t.maaned, frist)
          : KONKURRENCE_VINDER.notifikationKontakt(t.maaned, frist),
        link,
        // Kun id'er, vinderen selv har adgang til.
        data: samtaleId ? { staff_samtale_id: samtaleId } : {},
        mail: konkurrenceVinderMail({ maaned: t.maaned, frist, link: samtaleId ? link : null }),
        noegle: `konkurrence_vinder:${t.id}`,
      },
      { altidMail: true },
    );
    if (r.dublet) return { status: "allerede", samtaleId };
    if (!r.mail && !r.klokke && !r.push) {
      return await fejl("notifikation", r.sprunget ? "nøglen kunne ikke claimes" : "ingen kanal blev sendt");
    }
    return { status: "sendt", samtaleId, mail: r.mail, klokke: r.klokke };
  } catch (err) {
    return await fejl("uventet", err);
  }
}
