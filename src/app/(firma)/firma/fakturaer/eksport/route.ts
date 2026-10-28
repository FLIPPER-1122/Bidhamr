import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logDriftFejl } from "@/lib/drift";
import { indenForGraense } from "@/lib/rateLimit";
import { sendtPdf, type SendtRaekke } from "@/lib/erhverv/firmaFakturaServer";
import { firmaFakturaCsv, pdfFilnavn, type FirmaFakturaListe } from "@/lib/erhverv/firmaFaktura";
import { lavZip } from "@/lib/zip";

// Eksport til firmaets regnskab: alle SENDTE fakturaer og kreditnotaer med
// udstedelsesdato i perioden - som CSV eller PDF'er i en ZIP. Kun firmaet
// selv (firma_fakturaer_liste filtrerer på auth.uid()). Kun GET.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DATO = /^\d{4}-\d{2}-\d{2}$/;
const MAKS_ZIP = 500;

function gyldigDato(v: string | null): string | null {
  if (!v || !DATO.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

function tekst(status: number, besked: string) {
  return new NextResponse(besked, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const fra = gyldigDato(req.nextUrl.searchParams.get("fra"));
  const til = gyldigDato(req.nextUrl.searchParams.get("til"));
  const format = req.nextUrl.searchParams.get("format") === "zip" ? "zip" : "csv";
  if (!fra || !til || fra > til) return tekst(400, "Vælg en gyldig periode (fra og med - til og med).");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL(`/login?redirect=${encodeURIComponent("/firma/fakturaer")}`, req.url));
  if (!(await indenForGraense("firma_faktura_eksport", user.id))) return tekst(429, "Du har hentet mange filer på kort tid. Vent lidt, og prøv igen.");

  try {
    const { data, error } = await supabase.rpc("firma_fakturaer_liste");
    if (error) throw error;
    const liste = data as FirmaFakturaListe | null;
    if (!liste) return tekst(404, "Siden findes ikke.");
    const sendte = liste.fakturaer
      .filter((f) => f.status === "sendt" && f.data && f.data.udstedt_dato && f.data.udstedt_dato >= fra && f.data.udstedt_dato <= til)
      .sort((a, b) => (a.nummer ?? 0) - (b.nummer ?? 0));

    if (format === "csv") {
      return new NextResponse(firmaFakturaCsv(sendte.map((f) => f.data!)), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="fakturaer-${fra}-til-${til}.csv"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (sendte.length === 0) return tekst(404, "Der er ingen sendte fakturaer i perioden.");
    if (sendte.length > MAKS_ZIP) return tekst(400, `Vælg en kortere periode (højst ${MAKS_ZIP} fakturaer ad gangen).`);
    // Rækkerne er firmaets egne (RLS: saelger_id = auth.uid()).
    const { data: rader, error: raderFejl } = await supabase
      .from("firma_fakturaer")
      .select("id, firma_id, saelger_id, koeber_id, pdf_sti")
      .eq("saelger_id", user.id)
      .eq("status", "sendt")
      .in(
        "id",
        sendte.map((f) => f.id),
      );
    if (raderFejl) throw raderFejl;
    const vedId = new Map((rader as Omit<SendtRaekke, "status" | "data">[]).map((r) => [r.id, r]));
    const filer = [];
    for (const f of sendte) {
      const r = vedId.get(f.id);
      if (!r || r.saelger_id !== user.id) continue;
      filer.push({ navn: pdfFilnavn(f.data!), data: await sendtPdf({ ...r, status: "sendt", data: f.data }) });
    }
    return new NextResponse(Buffer.from(lavZip(filer)), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="fakturaer-${fra}-til-${til}.zip"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "firma/fakturaer/eksport", fejl: err, brugerId: user.id });
    return tekst(500, "Filen kunne ikke laves lige nu. Prøv igen om lidt.");
  }
}
