import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logDriftFejl } from "@/lib/drift";

// "Download dine data" (GDPR). Formularen på /konto poster hertil, og svaret
// er en JSON-fil. Indholdet bygges af mine_data() i databasen (udleder
// brugeren af auth.uid(), højst 1 gang i timen) - appen kan bruge samme RPC.
// POST (ikke GET), så et link eller prefetch ikke kan bruge timens udtræk.
export async function POST(req: NextRequest) {
  // Kun fra vores egen side (formularen på /konto).
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) {
    return NextResponse.json({ fejl: "Ugyldig forespørgsel." }, { status: 403 });
  }

  const supabase = await createClient();
  const { data: brugerData } = await supabase.auth.getUser();
  if (!brugerData.user) {
    return NextResponse.redirect(new URL("/login?redirect=/konto%23dine-data", req.url), 303);
  }

  const { data, error } = await supabase.rpc("mine_data");
  if (error) {
    const tilbage = new URL("/konto", req.url);
    if (error.code === "BHR01") {
      tilbage.searchParams.set("data", "vent");
    } else {
      await logDriftFejl({ kilde: "server", sti: "/konto/data", fejl: error, brugerId: brugerData.user.id });
      tilbage.searchParams.set("data", "fejl");
    }
    tilbage.hash = "dine-data";
    return NextResponse.redirect(tilbage, 303);
  }

  const dato = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });
  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="bidhamr-mine-data-${dato}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
