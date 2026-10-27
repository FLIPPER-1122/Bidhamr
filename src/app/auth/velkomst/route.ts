import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { FOR_MANGE_FORSOEG, indenForGraense, klientIp } from "@/lib/rateLimit";
import { erVelkomstBillet, slaaVelkomstBilletOp, velkomstBilletNoegle } from "@/lib/erhverv/velkomstBillet";

// Velkomstlinket i mailen til en ny firmakonto (src/lib/erhverv/velkomstBillet.ts).
// GET /auth/velkomst?b=<billet> - billetten gælder i 24 timer.
//
// Linket logger IKKE ind og bruger intet op ved visning (mail-scannere åbner
// links): der laves blot et frisk Supabase-engangslink (generateLink
// 'recovery' - sender ingen mail), og firmaet sendes til /auth/callback, som
// viser mellemsiden /bekraeft. Først knappen dér logger ind og fører til
// "Vælg din adgangskode" (/reset-password?velkommen=1). Det friske link
// gælder i Supabases normale tid (1 time) fra hver åbning.
//
// Udløbet, annulleret eller ukendt billet: login-siden med "Linket er
// udløbet - skriv til erhverv@bidhamr.dk" (velkommen_udloebet), som når
// Supabase-linket er udløbet. Har firmaet allerede logget ind: login-siden
// (så bruges adgangskoden eller "Glemt adgangskode").

export const dynamic = "force-dynamic";

function videre(req: NextRequest, sti: string, params?: Record<string, string>) {
  const url = new URL(sti, req.nextUrl.origin);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url, 303);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

export async function GET(req: NextRequest) {
  const billet = req.nextUrl.searchParams.get("b");
  if (!erVelkomstBillet(billet)) return videre(req, "/login", { fejl: "velkommen_udloebet" });

  if (
    !(await indenForGraense("erhverv_velkomst_ip", await klientIp())) ||
    !(await indenForGraense("erhverv_velkomst_billet", velkomstBilletNoegle(billet)))
  ) {
    return new NextResponse(FOR_MANGE_FORSOEG, {
      status: 429,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const admin = createAdminClient();
  try {
    const opslag = await slaaVelkomstBilletOp(admin, billet);
    if (opslag.kode === "logget_ind") return videre(req, "/login");
    if (opslag.kode !== "ok") return videre(req, "/login", { fejl: "velkommen_udloebet" });

    const { data: link, error } = await admin.auth.admin.generateLink({ type: "recovery", email: opslag.email });
    if (error || !link?.properties?.hashed_token) {
      throw new Error(`generateLink recovery: ${error?.code ?? ""} ${error?.message ?? "intet svar"}`);
    }
    // Samme vej som de gamle velkomstlinks (adminErhverv.ts, velkomstLink):
    // /auth/callback indløser ikke ved GET, men viser /bekraeft.
    return videre(req, "/auth/callback", {
      token_hash: link.properties.hashed_token,
      type: "recovery",
      next: "/reset-password?velkommen=1",
    });
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "auth/velkomst", fejl: err });
    return videre(req, "/login", { fejl: "velkommen_udloebet" });
  }
}
