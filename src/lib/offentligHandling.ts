// Kalder en af handlingerne i src/app/api/offentlig/[handling]/route.ts fra
// browseren. Bruges i stedet for en server action på offentlige sider, hvor
// en indlogget almindelig bruger skal kunne sende noget, mens siden er lukket
// (se gaten i src/lib/supabase/middleware.ts).
// Svaret har samme form som den bagvedliggende funktion. Ved netværksfejl
// o.l. returneres { fejl, kode: "fejl" }.

export type OffentligHandling =
  | "ny-adgangskode"
  | "dsa-anmeld"
  | "dsa-klage-afgoerelse"
  | "dsa-klage-anmelder"
  | "erhverv-henvendelse"
  | "firma-skift-pakke"
  | "firma-betal"
  | "firma-betalingskort";

const GENERISK = "Noget gik galt. Prøv igen om lidt.";

export async function kaldOffentligHandling<T>(
  handling: OffentligHandling,
  fd: FormData,
): Promise<T | { fejl: string; kode: string }> {
  try {
    const res = await fetch(`/api/offentlig/${handling}`, {
      method: "POST",
      body: fd,
      credentials: "same-origin",
      cache: "no-store",
    });
    const krop = (await res.json().catch(() => null)) as T | { fejl?: unknown } | null;
    if (krop && typeof krop === "object") return krop as T;
    return { fejl: GENERISK, kode: "fejl" };
  } catch {
    return { fejl: GENERISK, kode: "fejl" };
  }
}
