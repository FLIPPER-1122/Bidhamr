import "server-only";

// Data til visning: brugerens egne fakturaer (mine_fakturaer, RLS via
// auth.uid()) og PDF'en (kun ejeren, kun færdige dokumenter).

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { hentFakturaKonfig } from "./konfig";
import { lavDineroKlient } from "./dinero";
import { erPdf, pdfSti } from "./koe";

export type MinFaktura = {
  id: string;
  dokument: "faktura" | "kreditnota";
  part: "koeber" | "saelger";
  trade_id: string | null;
  titel: string | null;
  nummer: number | null;
  dato: string;
  beloeb_oere: number;
  moms_oere: number;
  linjer: { tekst: string; beloeb_oere: number }[];
  klar: boolean;
  krediterer_nummer: number | null;
};

// Brugerens fakturaer. null = kunne ikke hentes (fx migrationen er ikke kørt).
export async function hentMineFakturaer(
  supabase: SupabaseClient,
  tradeId?: string,
): Promise<MinFaktura[] | null> {
  const { data, error } = await supabase.rpc("mine_fakturaer", tradeId ? { p_trade: tradeId } : {});
  if (error) {
    console.error("mine_fakturaer:", error.message);
    return null;
  }
  // Nyeste først: dato, derefter nummer (et dokument uden nummer endnu er det
  // nyeste på dagen).
  return ((Array.isArray(data) ? data : []) as MinFaktura[]).sort(
    (a, b) =>
      b.dato.localeCompare(a.dato) ||
      (b.nummer ?? Number.MAX_SAFE_INTEGER) - (a.nummer ?? Number.MAX_SAFE_INTEGER),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FakturaPdf = { filnavn: string; pdf: Uint8Array };

// PDF'en for et dokument, brugeren selv er modtager af. null = findes ikke,
// er ikke brugerens, eller er ikke færdig endnu. Gemt i storage efter
// behandlingen; ellers hentes den én gang fra Dinero og gemmes.
export async function hentFakturaPdf(id: string, brugerId: string): Promise<FakturaPdf | null> {
  if (!UUID.test(id) || !UUID.test(brugerId)) return null;
  const admin = createAdminClient();
  const { data: f, error } = await admin
    .from("fakturaer")
    .select("id, bruger_id, dokument, status, pdf_sti, dinero_nummer, dinero_org")
    .eq("id", id)
    .eq("bruger_id", brugerId)
    .maybeSingle<{
      id: string;
      bruger_id: string;
      dokument: string;
      status: string;
      pdf_sti: string | null;
      dinero_nummer: number | null;
      dinero_org: string | null;
    }>();
  if (error) throw new Error(`fakturaer: ${error.message}`);
  if (!f || f.status !== "faerdig" || (f.dokument !== "faktura" && f.dokument !== "kreditnota")) return null;
  const filnavn = `BidHamr-${f.dokument === "kreditnota" ? "kreditnota" : "faktura"}-${f.dinero_nummer ?? f.id.slice(0, 8)}.pdf`;

  if (f.pdf_sti) {
    const { data: fil, error: hentFejl } = await admin.storage.from("fakturaer").download(f.pdf_sti);
    if (!hentFejl && fil) {
      const pdf = new Uint8Array(await fil.arrayBuffer());
      if (erPdf(pdf)) return { filnavn, pdf };
    }
    console.error("Faktura-PDF kunne ikke hentes fra storage - henter fra Dinero:", f.id, hentFejl?.message);
  }

  const konfig = hentFakturaKonfig();
  if (!konfig.ok || !f.dinero_org || f.dinero_org !== konfig.dinero.orgId) return null;
  const dinero = lavDineroKlient(konfig.dinero, { maksKald: 4 });
  const pdf = f.dokument === "kreditnota" ? await dinero.hentKreditnotaPdf(f.id) : await dinero.hentFakturaPdf(f.id);
  if (!erPdf(pdf)) return null;
  const sti = pdfSti(f);
  const { error: opFejl } = await admin.storage
    .from("fakturaer")
    .upload(sti, pdf, { contentType: "application/pdf", upsert: true, cacheControl: "0" });
  if (!opFejl) await admin.rpc("faktura_gem_pdf", { p_id: f.id, p_sti: sti });
  return { filnavn, pdf };
}
