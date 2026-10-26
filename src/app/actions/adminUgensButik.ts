"use server";

// Admin -> Erhverv -> Ugens butik (chef og sælger-rollen): book en uge
// manuelt (med betaling = firmaet betaler i Firma oversigt inden for 48 timer;
// uden betaling = efter en aftale), annullér en booking, og - kun chefen -
// annullér en betalt uge med eller uden refusion og ret prisen. Databasen
// tjekker rollen igen og logger alt i moderation_log
// (20261101020000_ugens_butik.sql). Pengene flyttes kun af
// src/lib/betaling/ugensButik.ts (Stripe, idempotency keys).

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertErhverv } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import {
  staffAnnullerUgensButik,
  staffBookUgensButik,
  staffSaetUgensButikPris,
  type StaffSvar,
} from "@/lib/betaling/ugensButik";

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const tekst = (f: FormData, n: string) => ((f.get(n) as string | null) ?? "").trim();
const STI = "/admin/erhverv/ugens-butik";

type Svar = { ok: true; status?: string; besked?: string } | { fejl: string };

async function koer(hvor: string, kunChef: boolean, fn: (staffId: string) => Promise<StaffSvar>): Promise<Svar> {
  let staffId: string | null = null;
  try {
    const { userId } = await assertErhverv(kunChef);
    staffId = userId;
    const r = await fn(userId);
    revalidatePath(STI);
    if ("fejl" in r) return { fejl: r.fejl };
    return { ok: true, status: r.status, besked: r.besked };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: "Ingen adgang." };
    }
    await logDriftFejl({ kilde: "action", sti: "admin", hvor: `Ugens butik: ${hvor}`, fejl: err, brugerId: staffId });
    return { fejl: GENERISK };
  }
}

// formData: firmaId, uge (mandag ÅÅÅÅ-MM-DD), medBetaling ("ja"/"nej"), begrundelse.
export async function bookUgensButikAction(formData: FormData): Promise<Svar> {
  const begrundelse = tekst(formData, "begrundelse");
  if (!begrundelse) return { fejl: "Skriv en begrundelse." };
  const med = tekst(formData, "medBetaling");
  if (med !== "ja" && med !== "nej") return { fejl: "Vælg, om firmaet skal betale." };
  return koer("book", false, (staffId) =>
    staffBookUgensButik(staffId, tekst(formData, "firmaId"), tekst(formData, "uge"), med === "ja", begrundelse),
  );
}

// formData: bookingId, begrundelse, refunder ("ja" = kun chefen).
export async function annullerUgensButikAction(formData: FormData): Promise<Svar> {
  const begrundelse = tekst(formData, "begrundelse");
  if (!begrundelse) return { fejl: "Skriv en begrundelse." };
  return koer("annullér", false, (staffId) =>
    staffAnnullerUgensButik(staffId, tekst(formData, "bookingId"), begrundelse, tekst(formData, "refunder") === "ja"),
  );
}

// formData: pris (hele kroner ekskl. moms, fx "500"). Kun chefen.
export async function saetUgensButikPrisAction(formData: FormData): Promise<Svar> {
  const kr = tekst(formData, "pris").replace(/\s/g, "").replace(/\./g, "");
  if (!/^\d{3,5}$/.test(kr)) return { fejl: "Skriv prisen i hele kroner ekskl. moms (100-10.000 kr.)." };
  return koer("pris", true, (staffId) => staffSaetUgensButikPris(staffId, Number(kr) * 100));
}
