"use server";

// Fejlrapporter fra browserens error boundaries til drift_fejl (/admin/drift).
// Kan kaldes af alle (også ikke-loggede), så input behandles som utroværdigt:
// - kun stien (ingen query-streng), afkortet besked og et digest i Nexts format
// - teksten renses for e-mails, tokens o.l. (src/lib/drift.ts)
// - bruger-id udledes af sessionen - tages aldrig fra klienten
// - loft: 10 pr. minut pr. IP her og 30 nye rækker pr. minut globalt i
//   databasen; samme digest tælles op i stedet for at give en ny række.
// Returnerer altid - kaster aldrig.
import { createClient } from "@/lib/supabase/server";
import { logDriftFejl } from "@/lib/drift";
import { indenForGraense, klientIp } from "@/lib/rateLimit";

export async function rapporterKlientFejl(input: {
  sti?: unknown;
  besked?: unknown;
  digest?: unknown;
}): Promise<{ ok: true } | { fejl: string }> {
  try {
    const sti = typeof input?.sti === "string" ? input.sti.slice(0, 500) : null;
    const besked =
      typeof input?.besked === "string" && input.besked.trim()
        ? input.besked.slice(0, 2000)
        : "(ingen besked)";
    const digest =
      typeof input?.digest === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(input.digest)
        ? input.digest
        : null;

    if (!(await indenForGraense("drift_fejl_ip", await klientIp()))) {
      return { fejl: "For mange fejlrapporter" };
    }

    let brugerId: string | null = null;
    try {
      const supabase = await createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      brugerId = user?.id ?? null;
    } catch {
      // Ukendt bruger - fejlen logges stadig.
    }

    await logDriftFejl({ kilde: "klient", sti, fejl: besked, digest, brugerId });
    return { ok: true };
  } catch (err) {
    console.error("rapporterKlientFejl fejlede:", err);
    return { fejl: "Fejlen kunne ikke rapporteres" };
  }
}
