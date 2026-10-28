import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { indenForGraense } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { UUID_RE, appBruger, bearerToken } from "@/lib/appApi";
import { hentSendtRaekke, sendtPdf } from "@/lib/erhverv/firmaFakturaServer";
import { pdfFilnavn } from "@/lib/erhverv/firmaFaktura";

// PDF af en SENDT faktura/kreditnota fra et firma.
// GET /api/firma-faktura/<id>   (appen: Bearer-token, hjemmesiden: cookie)
// Kun køberen (fakturaen er sendt til hende) eller firmaet selv. Adgangen
// tjekkes med brugerens egen klient (RLS på firma_fakturaer), og først
// derefter hentes filen med service role. ?download=1 = vedhæftet fil.
// Svar: 200 application/pdf | 401 | 404 (findes ikke / ikke din / ikke sendt) | 429 | 500.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function tekst(status: number, besked: string) {
  return new NextResponse(besked, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

async function bruger(req: NextRequest): Promise<{ id: string; supabase: SupabaseClient } | null> {
  const token = bearerToken(req);
  if (token) {
    const b = await appBruger(token);
    return b ? { id: b.bruger.id, supabase: b.supabase } : null;
  }
  if ((req.headers.get("authorization") ?? "").trim()) return null;
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user ? { id: data.user.id, supabase } : null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const b = await bruger(req);
  if (!b) return tekst(401, "Du er ikke logget ind. Log ind, og prøv igen.");
  if (!UUID_RE.test(id)) return tekst(404, "Fakturaen findes ikke.");
  if (!(await indenForGraense("firma_faktura_pdf", b.id))) return tekst(429, "Du har hentet mange fakturaer på kort tid. Vent lidt, og prøv igen.");
  try {
    // RLS: køberen ser kun sendte til sig, firmaet sine egne.
    const { data: synlig, error } = await b.supabase.from("firma_fakturaer").select("id, status").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!synlig || (synlig as { status: string }).status !== "sendt") return tekst(404, "Fakturaen findes ikke.");
    const r = await hentSendtRaekke(id);
    if (!r || r.status !== "sendt" || (r.koeber_id !== b.id && r.saelger_id !== b.id) || !r.data) {
      return tekst(404, "Fakturaen findes ikke.");
    }
    const pdf = await sendtPdf(r);
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${pdfFilnavn(r.data)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "api/firma-faktura/[id]", fejl: err, brugerId: b.id });
    return tekst(500, "Fakturaen kunne ikke hentes lige nu. Prøv igen om lidt.");
  }
}
