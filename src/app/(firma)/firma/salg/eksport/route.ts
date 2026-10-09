import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logDriftFejl } from "@/lib/drift";
import { fakturaCsv, type FakturaData } from "@/lib/erhverv/fakturaOplysninger";

// CSV med oplysninger til firmaets egen faktura på varen for alle betalte
// salg i en periode (Firma oversigt -> Salg). firma_faktura_salg tjekker
// auth.uid() i databasen og giver kun firmaets egne salg (null for alle
// andre). Kun GET - ingen ændringer.

export const dynamic = "force-dynamic";

const DATO = /^\d{4}-\d{2}-\d{2}$/;

function gyldigDato(v: string | null): string | null {
  if (!v || !DATO.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

function fejl(status: number, tekst: string) {
  return new NextResponse(tekst, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(req: NextRequest) {
  const fra = gyldigDato(req.nextUrl.searchParams.get("fra"));
  const til = gyldigDato(req.nextUrl.searchParams.get("til"));
  if (!fra || !til || fra > til) return fejl(400, "Vælg en gyldig periode (fra og med - til og med).");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL(`/login?redirect=${encodeURIComponent("/firma/salg")}`, req.url));

  const { data, error } = await supabase.rpc("firma_faktura_salg", { p_fra: fra, p_til: til });
  if (error) {
    await logDriftFejl({ kilde: "server", hvor: "firma/salg/eksport", fejl: error, brugerId: user.id });
    return fejl(500, "Noget gik galt. Prøv igen om lidt.");
  }
  if (!data) return fejl(404, "Siden findes ikke.");

  return new NextResponse(fakturaCsv(data as FakturaData), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="bidhamr-salg-${fra}-til-${til}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
