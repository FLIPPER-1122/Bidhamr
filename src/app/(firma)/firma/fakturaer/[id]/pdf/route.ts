import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logDriftFejl } from "@/lib/drift";
import { indenForGraense } from "@/lib/rateLimit";
import { kladdePdf, hentSendtRaekke, sendtPdf } from "@/lib/erhverv/firmaFakturaServer";
import { pdfFilnavn, type FirmaFakturaData } from "@/lib/erhverv/firmaFaktura";

// PDF af en faktura fra firmaet (kladde = forhåndsvisning med "KLADDE").
// Kun firmaet selv: firma_faktura_hent giver null for alle andre. Kun GET.
// ?download=1 gemmer filen i stedet for at åbne den.

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tekst(status: number, besked: string) {
  return new NextResponse(besked, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return tekst(404, "Fakturaen findes ikke.");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL(`/login?redirect=${encodeURIComponent(`/firma/fakturaer/${id}`)}`, req.url));
  if (!(await indenForGraense("firma_faktura_pdf", user.id))) return tekst(429, "Du har hentet mange PDF'er på kort tid. Vent lidt, og prøv igen.");

  try {
    const { data, error } = await supabase.rpc("firma_faktura_hent", { p_id: id });
    if (error) throw error;
    const f = data as { status: "kladde" | "sendt"; data: FirmaFakturaData | null } | null;
    if (!f || !f.data) return tekst(404, "Fakturaen findes ikke.");
    let pdf: Uint8Array;
    if (f.status === "sendt") {
      const r = await hentSendtRaekke(id);
      if (!r || r.saelger_id !== user.id) return tekst(404, "Fakturaen findes ikke.");
      pdf = await sendtPdf(r);
    } else {
      pdf = await kladdePdf(f.data);
    }
    const filnavn = pdfFilnavn(f.data);
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${filnavn}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "firma/fakturaer/pdf", fejl: err, brugerId: user.id });
    return tekst(500, "PDF'en kunne ikke laves lige nu. Prøv igen om lidt.");
  }
}
