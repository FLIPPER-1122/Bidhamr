"use server";

// Admin → Beta-invitationer (docs/BETA-TEST.md). Admin og chef inviterer,
// sender igen og tilbagekalder; KUN chefen åbner og lukker beta-testen.
// Adgangen tjekkes her (assertRole) OG i databasen (staff_chat_har_rolle i
// hver RPC, som kun service_role kan kalde - 20261017010000_beta_invitationer.sql).
// Alle ændringer logges i moderation_log af databasen. Fejl RETURNERES som
// { fejl } (Next.js skjuler kastede fejl i produktion).

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { FOR_MANGE_FORSOEG, indenForGraense } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { betaInvitationMail } from "@/lib/mails/beta";

class BrugerFejl extends Error {}

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STI = "/admin/beta";

export type BetaStatus = "inviteret" | "oprettet" | "mitid" | "tilbagekaldt";

export type BetaInvitation = {
  id: string;
  email: string;
  note: string | null;
  status: BetaStatus;
  inviteret_kl: string;
  inviteret_af_navn: string | null;
  sidst_sendt_kl: string | null;
  antal_sendt: number;
  konto_oprettet_kl: string | null;
  mitid_kl: string | null;
  tilbagekaldt_kl: string | null;
};

export type BetaOversigt = {
  betaAaben: boolean;
  kunInviterede: boolean;
  opdateretKl: string | null;
  invitationer: BetaInvitation[];
};

const KODE_FEJL: Record<string, string> = {
  ingen_adgang: "Du har ikke adgang til at gøre det.",
  ugyldig_email: "Skriv en gyldig e-mail.",
  ugyldig_note: "Noten må højst være 500 tegn.",
  for_mange: "Du har sendt mange invitationer på kort tid. Vent lidt, og prøv igen.",
  findes: "Der er allerede en aktiv invitation til den e-mail. Brug \"Send igen\" i listen.",
  ikke_fundet: "Invitationen findes ikke.",
  tilbagekaldt: "Invitationen er tilbagekaldt. Invitér e-mailen igen for at genaktivere den.",
  for_hurtigt: "Invitationen er lige blevet sendt. Vent et minut, før du sender den igen.",
};

async function koer<T>(navn: string, fn: () => Promise<T>): Promise<T | { fejl: string }> {
  try {
    return await fn();
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: KODE_FEJL.ingen_adgang };
    }
    console.error(`Beta-handling ${navn} fejlede:`, err);
    await logDriftFejl({ kilde: "action", hvor: `adminBeta.${navn}`, fejl: err });
    return { fejl: GENERISK };
  }
}

function tjekUuid(id: unknown): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new BrugerFejl("Ugyldigt id.");
  return id;
}

// Svaret fra en RPC: { kode: 'ok', ... } eller en fejlkode.
async function rpc(
  admin: Awaited<ReturnType<typeof assertRole>>["admin"],
  navn: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await admin.rpc(navn, args);
  if (error) throw new Error(`${navn}: ${error.message}`);
  const svar = (data ?? {}) as Record<string, unknown>;
  const kode = typeof svar.kode === "string" ? svar.kode : "";
  if (kode !== "ok" && kode !== "uaendret") {
    throw new BrugerFejl(KODE_FEJL[kode] ?? GENERISK);
  }
  return svar;
}

// Til siden (server component). Kræver admin (databasen tjekker igen).
export async function hentBetaOversigt(): Promise<BetaOversigt | { fejl: string }> {
  return koer("hentBetaOversigt", async () => {
    const { admin, userId } = await assertRole("admin");
    const svar = await rpc(admin, "beta_oversigt", { p_staff: userId });
    return {
      betaAaben: svar.beta_aaben === true,
      kunInviterede: svar.kun_inviterede !== false,
      opdateretKl: typeof svar.opdateret_kl === "string" ? svar.opdateret_kl : null,
      invitationer: Array.isArray(svar.invitationer) ? (svar.invitationer as BetaInvitation[]) : [],
    };
  });
}

async function sendInvitation(email: string, harKonto: boolean, staffId: string): Promise<boolean> {
  const sendt = await sendHandelMailDetaljer(email, betaInvitationMail({ email, harKonto }));
  if (!sendt.ok) {
    await logDriftFejl({ kilde: "action", hvor: "adminBeta.invitationsmail", fejl: sendt.fejl, brugerId: staffId });
  }
  return sendt.ok;
}

// Ny invitation (eller genaktivering af en tilbagekaldt). E-mailen
// normaliseres (trim + små bogstaver) her og i databasen.
export async function inviterBetaTester(input: { email: string; note?: string | null }) {
  return koer("inviterBetaTester", async () => {
    const { admin, userId } = await assertRole("admin");
    const email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email) || email.length > 320) throw new BrugerFejl(KODE_FEJL.ugyldig_email);
    const note = typeof input?.note === "string" ? input.note.replace(/\s+/g, " ").trim() : "";
    if (note.length > 500) throw new BrugerFejl(KODE_FEJL.ugyldig_note);
    if (!(await indenForGraense("beta_invitation_staff", userId))) throw new BrugerFejl(FOR_MANGE_FORSOEG);

    const svar = await rpc(admin, "beta_inviter", { p_staff: userId, p_email: email, p_note: note || null });
    const mailSendt = await sendInvitation(email, svar.har_konto === true, userId);
    revalidatePath(STI);
    const hvad = svar.genaktiveret === true ? "Invitationen er genaktiveret" : "Invitationen er gemt";
    return {
      ok: true as const,
      mailSendt,
      besked: mailSendt
        ? `${hvad}, og mailen er sendt til ${email}.`
        : `${hvad}, men mailen kunne ikke sendes. Brug "Send igen" om lidt.`,
    };
  });
}

export async function sendBetaInvitationIgen(id: string) {
  return koer("sendBetaInvitationIgen", async () => {
    const { admin, userId } = await assertRole("admin");
    const invitationId = tjekUuid(id);
    if (!(await indenForGraense("beta_invitation_staff", userId))) throw new BrugerFejl(FOR_MANGE_FORSOEG);
    const svar = await rpc(admin, "beta_send_igen", { p_staff: userId, p_id: invitationId });
    const email = typeof svar.email === "string" ? svar.email : "";
    if (!email) throw new Error("beta_send_igen: ingen e-mail i svaret");
    const mailSendt = await sendInvitation(email, svar.har_konto === true, userId);
    revalidatePath(STI);
    if (!mailSendt) throw new BrugerFejl("Mailen kunne ikke sendes. Prøv igen om lidt.");
    return { ok: true as const, besked: `Invitationen er sendt igen til ${email}.` };
  });
}

// Tilbagekald én invitation. Kontoen og dens data bevares.
export async function tilbagekaldBetaInvitation(id: string) {
  return koer("tilbagekaldBetaInvitation", async () => {
    const { admin, userId } = await assertRole("admin");
    const svar = await rpc(admin, "beta_tilbagekald", { p_staff: userId, p_id: tjekUuid(id) });
    revalidatePath(STI);
    return {
      ok: true as const,
      besked: svar.kode === "uaendret" ? "Invitationen var allerede tilbagekaldt." : "Invitationen er tilbagekaldt.",
    };
  });
}

// Kontakten "Beta åben/lukket" - kun chef.
export async function saetBetaAaben(aaben: boolean) {
  return koer("saetBetaAaben", async () => {
    if (typeof aaben !== "boolean") throw new BrugerFejl("Ugyldigt valg.");
    const { admin, userId } = await assertRole("chef");
    await rpc(admin, "beta_saet_aaben", { p_staff: userId, p_aaben: aaben });
    revalidatePath(STI);
    return {
      ok: true as const,
      besked: aaben
        ? "Beta-testen er åben. Inviterede kan nu oprette sig og bruge siden."
        : "Beta-testen er lukket. Beta-testerne ser coming-soon inden for 5 minutter. Deres data er bevaret.",
    };
  });
}
