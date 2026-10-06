import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { lavCsp, lavNonce } from "@/lib/csp";

export async function proxy(request: NextRequest) {
  // Ny nonce for hver forespoergsel. Den sendes med til renderingen (request-
  // headere) og til browseren (response-header) - ogsaa ved redirects.
  const nonce = lavNonce();
  const csp = lavCsp(nonce);

  const response = await updateSession(request, { "x-nonce": nonce, "Content-Security-Policy": csp });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

// Kun rigtige statiske filer springes over: Next' egne filer, favicon, filerne
// i public/ (brand/, forside/ og de løse svg'er) og metadata-filerne i
// src/app (icon.svg, apple-icon.png, opengraph-image.jpg). Tidligere blev
// ALLE stier, der endte på .png/.jpg osv., sprunget over - så kunne en server
// action kaldes via POST /auktion/x.jpg helt uden om gaten. Tilføjes en fil i
// public/, skal den med her, ellers går den bare gennem gaten.
//
// En server action kan stadig sendes til en udeladt sti (fx POST
// /brand/x.png). Derfor kører proxyen ALTID, når forespørgslen har en krop
// (content-type) eller en Next-Action-header - almindelige GET'er af statiske
// filer har ingen af delene.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico$|brand/|forside/|(?:file|globe|next|vercel|window|icon)\\.svg$|apple-icon\\.png$|opengraph-image\\.jpg$).*)",
    { source: "/:path*", has: [{ type: "header", key: "content-type" }] },
    { source: "/:path*", has: [{ type: "header", key: "next-action" }] },
  ],
};
