import { NextResponse, type NextRequest } from "next/server";
import { createClient as lavKlient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { logDriftFejl } from "@/lib/drift";
import { hentFakturaPdf } from "@/lib/faktura/data";

// Hent en faktura/kreditnota fra BidHamr som PDF.
//
// GET /api/faktura/<id>
//   Hjemmesiden: almindeligt login (cookie).
//   Appen:       Authorization: Bearer <Supabase access token>
// Svar: 200 application/pdf | 401 ikke logget ind | 404 findes ikke, er ikke
// din, eller er ikke klar endnu | 429 for mange | 500 fejl.
//
// Kun modtageren (fakturaer.bruger_id = den indloggede) kan hente den. Id'et
// er en uuid; alt andet giver 404. Proxyen lukker stien igennem uden
// cookie-login (src/lib/supabase/middleware.ts), så appen kan bruge Bearer -
// login tjekkes her.

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tekst(status: number, besked: string) {
  return new NextResponse(besked, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function brugerId(req: NextRequest): Promise<string | null> {
  const auth = (req.headers.get("authorization") ?? "").trim();
  if (auth) {
    const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(auth);
    if (!m) return null;
    const supabase = lavKlient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await supabase.auth.getUser(m[1]);
    return error || !data.user ? null : data.user.id;
  }
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

// 60 PDF'er i timen pr. bruger (samme tabel som src/lib/rateLimit.ts).
// Fejler databasen, slippes forespørgslen igennem (som rateLimit.ts).
async function indenForGraense(id: string): Promise<boolean> {
  try {
    const { data, error } = await createAdminClient().rpc("rate_limit_tjek", {
      p_noegle: `faktura_pdf_bruger:${id}`,
      p_maks: 60,
      p_vindue_sek: 60 * 60,
    });
    return error ? true : data !== false;
  } catch {
    return true;
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const bruger = await brugerId(req);
  if (!bruger) return tekst(401, "Du er ikke logget ind. Log ind, og prøv igen.");
  if (!UUID.test(id)) return tekst(404, "Fakturaen findes ikke.");
  if (!(await indenForGraense(bruger))) return tekst(429, "Du har hentet mange fakturaer på kort tid. Vent lidt, og prøv igen.");

  try {
    const fil = await hentFakturaPdf(id.toLowerCase(), bruger);
    if (!fil) return tekst(404, "Fakturaen findes ikke, eller den er ikke klar endnu. Prøv igen om lidt.");
    return new NextResponse(Buffer.from(fil.pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${fil.filnavn}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/faktura", fejl: err, brugerId: bruger });
    return tekst(500, "Fakturaen kunne ikke hentes lige nu. Prøv igen om lidt.");
  }
}
