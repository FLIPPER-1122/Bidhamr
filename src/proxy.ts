import { type NextRequest } from "next/server";
import { adminGate, saetAdminHeadere, updateSession } from "@/lib/supabase/middleware";
import { lavCsp, lavNonce } from "@/lib/csp";
import { erAdminVaert } from "@/lib/adminVaert";

export async function proxy(request: NextRequest) {
  // Ny nonce for hver forespoergsel. Den sendes med til renderingen (request-
  // headere) og til browseren (response-header) - ogsaa ved redirects.
  const nonce = lavNonce();

  // Admin på egen host (ADMIN_VAERT, docs/ADMIN-VAERT.md): delt tidligt.
  // Admin-hosten har sin egen tilladelsesliste, sin egen session-cookie og
  // sin egen CSP-zone - hovedsitets gate (før lancering, firma, beta) køres
  // ikke dér. Uden ADMIN_VAERT er erAdminVaert altid false.
  if (erAdminVaert(request.headers.get("host"))) {
    const csp = lavCsp(nonce, "admin");
    const response = await adminGate(request, { "x-nonce": nonce, "Content-Security-Policy": csp });
    response.headers.set("Content-Security-Policy", csp);
    return saetAdminHeadere(response);
  }

  const csp = lavCsp(nonce);
  const response = await updateSession(request, { "x-nonce": nonce, "Content-Security-Policy": csp });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

// Henvis en ven (?ven=KODE) gemmer intet i browseren (Filip, 27. okt. 2026):
// koden følger med i URL'en til opret konto (src/lib/henvisning/kode.ts).

// Kun rigtige statiske filer springes over: Next' egne filer, favicon, filerne
// i public/ (brand/, forside/ og de løse svg'er) og metadata-filerne i
// src/app (icon.svg, icon1.png, apple-icon.png, opengraph-image.jpg). Tidligere blev
// ALLE stier, der endte på .png/.jpg osv., sprunget over - så kunne en server
// action kaldes via POST /auktion/x.jpg helt uden om gaten. Tilføjes en fil i
// public/, skal den med her, ellers går den bare gennem gaten.
//
// En server action kan stadig sendes til en udeladt sti (fx POST
// /brand/x.png). Derfor kører proxyen ALTID, når forespørgslen har en krop
// (content-type) eller en Next-Action-header - almindelige GET'er af statiske
// filer har ingen af delene.
//
// Admin-hosten: de udeladte statiske filer (brand/, forside/ ...) serveres
// også dér uden proxy - det er offentlige filer, og alle andre stier giver 404.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico$|brand/|forside/|(?:file|globe|next|vercel|window|icon)\\.svg$|(?:apple-icon|icon1)\\.png$|opengraph-image\\.jpg$).*)",
    { source: "/:path*", has: [{ type: "header", key: "content-type" }] },
    { source: "/:path*", has: [{ type: "header", key: "next-action" }] },
  ],
};
