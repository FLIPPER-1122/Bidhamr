// "Logget ind som" i pengetestene: en rigtig Supabase-session (anon-nøgle +
// brugerens adgangstoken), så RLS og auth.uid() virker som for en rigtig
// bruger. Server actions får denne klient fra createClient (opsaetning.ts).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { createAdminClient } from "@/lib/supabase/admin";

let aktiv: SupabaseClient | null = null;
const klienter = new Map<string, SupabaseClient>();

// En ny tilfældig adgangskode pr. kørsel - kun på pengetestenes egne
// TEST-brugere (aldrig seed-brugerne). Adgangskoden gemmes ingen steder.
export async function logIndSom(brugerId: string, email: string): Promise<SupabaseClient> {
  const kendt = klienter.get(brugerId);
  if (kendt) {
    aktiv = kendt;
    return kendt;
  }
  if (!email.startsWith("penge-") || !email.endsWith("@test.bidhamr.dk")) {
    throw new Error(`logIndSom: kun pengetestenes egne brugere (${email})`);
  }
  const adgangskode = `Pt-${randomBytes(18).toString("base64url")}`;
  const { error: aFejl } = await createAdminClient().auth.admin.updateUserById(brugerId, { password: adgangskode });
  if (aFejl) throw new Error(`adgangskode: ${aFejl.message}`);
  const klient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await klient.auth.signInWithPassword({ email, password: adgangskode });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  klienter.set(brugerId, klient);
  aktiv = klient;
  return klient;
}

export function logUd(): void {
  aktiv = null;
}

export function aktivKlient(): SupabaseClient {
  if (aktiv) return aktiv;
  // Ingen bruger: en klient uden session (som en besøgende).
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
