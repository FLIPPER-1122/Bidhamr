import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logDriftFejl } from "@/lib/drift";
import { lavMineDataPdf } from "@/lib/pdf/mineDataPdf";

// "Download dine data" (GDPR). Formularen på /konto poster hertil, og svaret
// er en JSON-fil (art. 20, maskinlæsbar) eller en PDF til at læse
// (format=pdf). Indholdet bygges af mine_data() i databasen (udleder
// brugeren af auth.uid(), højst 1 gang i timen) - appen kan bruge samme RPC.
// PDF og JSON bygger på præcis samme kald, så grænsen deles: én fil i timen,
// uanset format. Det kræver ingen ny databasefunktion, og PDF'en kan ikke
// bruges til at omgå grænsen.
// POST (ikke GET), så et link eller prefetch ikke kan bruge timens udtræk.
export async function POST(req: NextRequest) {
  // Kun fra vores egen side (formularen på /konto). Sammenlignes med
  // Host-headeren, så det også virker bag Vercels proxy.
  const vaert = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const origin = req.headers.get("origin");
  let fremmed = false;
  try {
    fremmed = !!origin && new URL(origin).host !== vaert;
  } catch {
    fremmed = true;
  }
  if (fremmed) {
    return NextResponse.json({ fejl: "Ugyldig forespørgsel." }, { status: 403 });
  }
  const base = origin ?? req.nextUrl.origin;

  // Firma-dashboardet (/firma/oplysninger) sender fra=firma med, så en fejl
  // ("vent"/"fejl") vises dér - /konto sender en firmakonto til /firma.
  // Kun de faste værdier bruges, aldrig en sti fra formularen.
  let fraFirma = false;
  let somPdf = false;
  try {
    const formular = await req.formData();
    fraFirma = formular.get("fra") === "firma";
    somPdf = formular.get("format") === "pdf";
  } catch {
    fraFirma = false;
    somPdf = false;
  }
  const tilbageSti = fraFirma ? "/firma/oplysninger" : "/konto";
  const tilbageMed = (status: "vent" | "fejl") => {
    const tilbage = new URL(tilbageSti, base);
    tilbage.searchParams.set("data", status);
    tilbage.hash = "dine-data";
    return NextResponse.redirect(tilbage, 303);
  };

  const supabase = await createClient();
  const { data: brugerData } = await supabase.auth.getUser();
  if (!brugerData.user) {
    return NextResponse.redirect(new URL(`/login?redirect=${encodeURIComponent(`${tilbageSti}#dine-data`)}`, base), 303);
  }

  const { data, error } = await supabase.rpc("mine_data");
  if (error) {
    if (error.code === "BHR01") return tilbageMed("vent");
    await logDriftFejl({ kilde: "server", sti: "/konto/data", fejl: error, brugerId: brugerData.user.id });
    return tilbageMed("fejl");
  }

  // Egne maksimumbud (automatisk bud) er med i mine_data() under
  // "mine_maksimumbud" (20261010010000_autobud.sql) - også for appen.

  const dato = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });

  if (somPdf) {
    let pdf: Uint8Array;
    try {
      pdf = await lavMineDataPdf(data);
    } catch (e) {
      await logDriftFejl({ kilde: "server", sti: "/konto/data", fejl: e, brugerId: brugerData.user.id });
      return tilbageMed("fejl");
    }
    return new NextResponse(new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="bidhamr-dine-data-${dato}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="bidhamr-mine-data-${dato}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
