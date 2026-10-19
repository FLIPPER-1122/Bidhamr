"use server";

// "Meld fejl" i beta-testen (docs/BETA-TEST.md). Kun før lancering, kun for
// beta-testere og staff. Rollen og beta-adgangen slås op i databasen her
// (knappen bruger kun den signerede rolle-cookie til at blive vist).
// Rækken indsættes med service_role via beta_fejl_opret
// (20261018020000_beta_fejl.sql), der også tjekker billederne og har sit eget
// loft. Billederne er allerede uploadet af browseren til brugerens egen mappe
// i bucket 'beta-fejl-billeder'. Fejl RETURNERES som { fejl }.
//
// Alvor "blokerer" sender en kort alarm-mail til DRIFT_ALARM_MAIL (højst 6 i
// timen). Mailen indeholder ingen tekst fra brugeren - kun et link til
// Admin -> Beta-fejl.

import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { foerLancering } from "@/lib/lancering";
import { maaMeldeBetaFejl } from "@/lib/betaFejlAdgang";
import { graenseFejl, indenForGraense, tjekGraenserLukket } from "@/lib/rateLimit";
import { logDriftFejl, renFejltekst, renSti } from "@/lib/drift";
import { alarmModtagere } from "@/lib/driftAlarm";
import { bygMail } from "@/lib/mails/layout";
import { adminAbsolutUrl } from "@/lib/adminVaert";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import {
  BETA_FEJL_FEJL,
  BETA_FEJL_MAKS_BILLEDER,
  BETA_FEJL_MAKS_FORVENTET,
  BETA_FEJL_MAKS_TEKST,
  BETA_FEJL_STI_MOENSTER,
  erAlvor,
} from "@/lib/betaFejl";

const GENERISK = "Fejlen kunne ikke sendes. Prøv igen om lidt.";

export type BetaFejlInput = {
  alvor: string;
  tekst: string;
  forventet?: string | null;
  sti?: string | null;
  browser?: string | null;
  skaerm?: string | null;
  billeder?: string[];
};

// Fjerner kontroltegn (men beholder linjeskift i fritekst).
function renFritekst(v: unknown, maks: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim().slice(0, maks + 1);
}

function renLinje(v: unknown, maks: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, maks) : null;
}

async function sendAlarm(fejlId: string) {
  const modtagere = alarmModtagere();
  if (modtagere.length === 0) return;
  if (!(await indenForGraense("beta_fejl_alarm", "alle"))) return;
  const mail = bygMail({
    preheader: "En beta-tester er gået i stå",
    overskriftHtml: "Ny beta-fejl: blokerer",
    afsnitHtml: [
      "En beta-tester har meldt en fejl, der forhindrer dem i at komme videre. Teksten står kun i admin.",
    ],
    knap: { tekst: "Åbn Beta-fejl", url: adminAbsolutUrl("/admin/beta-fejl?alvor=blokerer") },
    aarsag: "Du får denne mail, fordi din adresse står i DRIFT_ALARM_MAIL. Højst 6 af disse mails i timen.",
  });
  for (const til of modtagere) {
    const r = await sendHandelMailDetaljer(til, { subject: "BidHamr-alarm: beta-fejl, der blokerer", ...mail });
    if (!r.ok) {
      console.error("Beta-fejl: alarm-mail kunne ikke sendes:", renFejltekst(r.fejl, 200));
      await logDriftFejl({ kilde: "action", hvor: "betaFejl.alarm", fejl: `${r.fejl} (fejl ${fejlId})` });
    }
  }
}

export async function indsendBetaFejl(input: BetaFejlInput): Promise<{ ok: true } | { fejl: string }> {
  try {
    if (!foerLancering()) return { fejl: BETA_FEJL_FEJL.ingen_adgang };

    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: "Du skal være logget ind." };

    // Rolle, beta-adgang og kontotype fra databasen (som gaten, men uden cookie).
    const [{ data: rolle }, { data: beta }, { data: konto }] = await Promise.all([
      supabase.rpc("min_rolle"),
      supabase.rpc("min_beta_adgang"),
      supabase.from("users").select("konto_type").eq("id", user.id).maybeSingle<{ konto_type: string | null }>(),
    ]);
    const maa = maaMeldeBetaFejl({
      rolle: typeof rolle === "string" ? rolle : "",
      kontoType: konto?.konto_type ?? null,
      beta: beta === true,
    });
    if (!maa) return { fejl: BETA_FEJL_FEJL.ingen_adgang };

    // Felterne.
    if (!erAlvor(input?.alvor)) return { fejl: BETA_FEJL_FEJL.ugyldig_alvor };
    const tekst = renFritekst(input.tekst, BETA_FEJL_MAKS_TEKST);
    if (tekst.length < 1 || tekst.length > BETA_FEJL_MAKS_TEKST) return { fejl: BETA_FEJL_FEJL.ugyldig_tekst };
    const forventet = renFritekst(input.forventet, BETA_FEJL_MAKS_FORVENTET);
    if (forventet.length > BETA_FEJL_MAKS_FORVENTET) {
      return { fejl: `Feltet "Hvad havde du forventet?" må højst være ${BETA_FEJL_MAKS_FORVENTET} tegn.` };
    }
    const billeder = Array.isArray(input.billeder) ? input.billeder : [];
    if (
      billeder.length > BETA_FEJL_MAKS_BILLEDER ||
      !billeder.every((b) => typeof b === "string" && BETA_FEJL_STI_MOENSTER.test(b) && b.startsWith(`${user.id}/`))
    ) {
      return { fejl: BETA_FEJL_FEJL.ugyldige_billeder };
    }

    const graense = await tjekGraenserLukket([["beta_fejl_bruger", user.id]]);
    if (graense === "for_mange") return { fejl: BETA_FEJL_FEJL.for_mange };
    if (graense !== "ok") return { fejl: graenseFejl(graense) ?? GENERISK };

    const { data, error } = await createAdminClient().rpc("beta_fejl_opret", {
      p_bruger: user.id,
      p_sti: renSti(input.sti) ?? null,
      p_alvor: input.alvor,
      p_tekst: tekst,
      p_forventet: forventet || null,
      p_browser: renLinje(input.browser, 400),
      p_skaerm: renLinje(input.skaerm, 100),
      p_billeder: billeder,
    });
    if (error) throw new Error(`beta_fejl_opret: ${error.message}`);
    const svar = (data ?? {}) as { kode?: unknown; id?: unknown };
    if (svar.kode !== "ok") {
      const kode = typeof svar.kode === "string" ? svar.kode : "";
      return { fejl: BETA_FEJL_FEJL[kode] ?? GENERISK };
    }

    if (input.alvor === "blokerer" && typeof svar.id === "string") {
      const id = svar.id;
      after(() => sendAlarm(id));
    }
    return { ok: true };
  } catch (err) {
    console.error("indsendBetaFejl fejlede:", err);
    await logDriftFejl({ kilde: "action", hvor: "indsendBetaFejl", fejl: err });
    return { fejl: GENERISK };
  }
}
