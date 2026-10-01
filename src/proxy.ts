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

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
