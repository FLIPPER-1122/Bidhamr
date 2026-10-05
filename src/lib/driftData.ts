import "server-only";

// Data til /admin/drift. Kaldes kun fra siden efter assertRole("admin"), med
// service-role-klienten derfra. Ingen mailindhold og ingen nøgler fra
// notifikation_afsendelser (de kan indeholde andre brugeres id) - kun type,
// kanal, status, fejltekst og modtagerens id + maskeret e-mail.
import type { createAdminClient } from "@/lib/supabase/admin";
import { maskerEmail } from "@/lib/drift";

type Admin = ReturnType<typeof createAdminClient>;

const MIN = 60 * 1000;
const TIME = 60 * MIN;
const DAG = 24 * TIME;

// Vores cron-rute kaldes hvert 5. minut. Er der ikke kørt med succes i 15
// minutter, vises en advarsel.
export const CRON_ADVARSEL_MIN = 15;
// En claimet notifikation, der ikke er meldt færdig efter 10 minutter, er
// gået tabt (processen døde midt i afsendelsen).
export const CLAIM_HAENGER_MIN = 10;

// Tabel eller funktion findes ikke: migrationen er ikke kørt.
function mangler(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "42883" ||
    error.code === "42703" ||
    error.code === "PGRST202" ||
    error.code === "PGRST204" ||
    error.code === "PGRST205"
  );
}

export type Sektion<T> =
  | { tilstand: "ok"; data: T }
  | { tilstand: "mangler" }
  | { tilstand: "fejl"; besked: string };

function sektion<T>(error: { code?: string; message?: string } | null, data: T): Sektion<T> {
  if (mangler(error)) return { tilstand: "mangler" };
  if (error) return { tilstand: "fejl", besked: error.message ?? "Ukendt fejl" };
  return { tilstand: "ok", data };
}

// ------------------------------------------------------------------ cron

export type CronKoersel = {
  id: number;
  metode: string | null;
  startet_kl: string;
  afsluttet_kl: string | null;
  ok: boolean | null;
  fejl: string | null;
};

export type CronRute = {
  seneste: CronKoersel[];
  sidsteOk: string | null;
  fejl24t: number;
  koersler24t: number;
};

export async function hentCronRute(admin: Admin, nu: number): Promise<Sektion<CronRute>> {
  const fra24 = new Date(nu - DAG).toISOString();
  const [seneste, sidsteOk, fejl, alle] = await Promise.all([
    admin
      .from("drift_cron_koersler")
      .select("id, metode, startet_kl, afsluttet_kl, ok, fejl")
      .eq("job", "betalings-cron")
      .order("startet_kl", { ascending: false })
      .limit(15),
    admin
      .from("drift_cron_koersler")
      .select("startet_kl")
      .eq("job", "betalings-cron")
      .eq("ok", true)
      .order("startet_kl", { ascending: false })
      .limit(1)
      .maybeSingle<{ startet_kl: string }>(),
    admin
      .from("drift_cron_koersler")
      .select("id", { count: "exact", head: true })
      .eq("job", "betalings-cron")
      .eq("ok", false)
      .gte("startet_kl", fra24),
    admin
      .from("drift_cron_koersler")
      .select("id", { count: "exact", head: true })
      .eq("job", "betalings-cron")
      .gte("startet_kl", fra24),
  ]);
  const error = seneste.error ?? sidsteOk.error ?? fejl.error ?? alle.error;
  return sektion(error, {
    seneste: (seneste.data ?? []) as CronKoersel[],
    sidsteOk: sidsteOk.data?.startet_kl ?? null,
    fejl24t: fejl.count ?? 0,
    koersler24t: alle.count ?? 0,
  });
}

export type PgCronJob = {
  jobid: number;
  jobname: string | null;
  schedule: string;
  active: boolean;
  sidste_start: string | null;
  sidste_slut: string | null;
  sidste_status: string | null;
  sidste_besked: string | null;
  sidste_ok: string | null;
  koersler_24t: number;
  fejl_24t: number;
  seneste_fejl_kl: string | null;
  seneste_fejl: string | null;
};

export async function hentPgCron(admin: Admin): Promise<Sektion<PgCronJob[]>> {
  const { data, error } = await admin.rpc("admin_cron_status");
  return sektion(error, ((data ?? []) as PgCronJob[]).map((j) => ({
    ...j,
    koersler_24t: Number(j.koersler_24t ?? 0),
    fejl_24t: Number(j.fejl_24t ?? 0),
  })));
}

export type HttpSvar = {
  id: number;
  oprettet_kl: string | null;
  status_code: number | null;
  timed_out: boolean | null;
  fejl: string | null;
};

export async function hentHttpSvar(admin: Admin): Promise<Sektion<HttpSvar[]>> {
  const { data, error } = await admin.rpc("admin_cron_http_svar");
  return sektion(error, (data ?? []) as HttpSvar[]);
}

// ------------------------------------------------------------------ notifikationer

export type IkkeSendt = {
  noegle: string; // kun til React-key - vises aldrig
  tid: string;
  type: string;
  kanal: string;
  status: "fejlet" | "delvis" | "haenger" | "fejl";
  fejl: string | null;
  brugerId: string | null;
  email: string;
};

type AfsendelseRaekke = {
  noegle: string;
  bruger_id: string | null;
  type: string;
  oprettet_kl: string;
  status: string | null;
  kanaler: Record<string, string> | null;
  fejl: string | null;
};

type FejlRaekke = {
  id: number;
  oprettet_kl: string;
  senest_kl: string;
  antal: number;
  kilde: string;
  sti: string | null;
  besked: string;
  digest: string | null;
  bruger_id: string | null;
};

// "mail: Resend: ... | push: ..." -> "mail, push"
function kanalerFraTekst(tekst: string): string {
  const k = [...tekst.matchAll(/(?:^|\| )(klokke|mail|push):/g)].map((m) => m[1]);
  return k.length > 0 ? [...new Set(k)].join(", ") : "—";
}

export async function hentIkkeSendte(admin: Admin, nu: number): Promise<Sektion<IkkeSendt[]>> {
  const fra7 = new Date(nu - 7 * DAG).toISOString();
  const haengerFoer = new Date(nu - CLAIM_HAENGER_MIN * MIN).toISOString();
  const [afs, fejl] = await Promise.all([
    admin
      .from("notifikation_afsendelser")
      .select("noegle, bruger_id, type, oprettet_kl, status, kanaler, fejl")
      .gte("oprettet_kl", fra7)
      .or(`status.in.(fejlet,delvis),and(status.eq.claimet,oprettet_kl.lt."${haengerFoer}")`)
      .order("oprettet_kl", { ascending: false })
      .limit(200),
    admin
      .from("drift_fejl")
      .select("id, oprettet_kl, senest_kl, antal, kilde, sti, besked, digest, bruger_id")
      .eq("kilde", "notifikation")
      .gte("senest_kl", fra7)
      .order("senest_kl", { ascending: false })
      .limit(200),
  ]);
  const error = afs.error ?? fejl.error;
  if (error) return sektion(error, []);

  const raekker: IkkeSendt[] = [];
  for (const r of (afs.data ?? []) as AfsendelseRaekke[]) {
    const fejlede = Object.entries(r.kanaler ?? {})
      .filter(([, v]) => v === "fejl")
      .map(([k]) => k);
    raekker.push({
      noegle: `a:${r.noegle}`,
      tid: r.oprettet_kl,
      type: r.type,
      kanal: r.status === "claimet" ? "—" : fejlede.join(", ") || "—",
      status: r.status === "claimet" ? "haenger" : (r.status as "fejlet" | "delvis"),
      fejl: r.status === "claimet" ? "Claimet, men afsendelsen blev aldrig meldt færdig" : r.fejl,
      brugerId: r.bruger_id,
      email: "",
    });
  }
  for (const r of (fejl.data ?? []) as FejlRaekke[]) {
    raekker.push({
      noegle: `f:${r.id}`,
      tid: r.senest_kl,
      type: (r.sti ?? "").replace(/^\/?notifikation:/, "") || "—",
      kanal: kanalerFraTekst(r.besked),
      status: "fejl",
      fejl: r.antal > 1 ? `${r.besked} (${r.antal} gange)` : r.besked,
      brugerId: r.bruger_id,
      email: "",
    });
  }
  raekker.sort((a, b) => (a.tid < b.tid ? 1 : -1));

  const ids = [...new Set(raekker.map((r) => r.brugerId).filter(Boolean) as string[])];
  if (ids.length > 0) {
    const { data: brugere } = await admin.from("users").select("id, email").in("id", ids);
    const map = new Map((brugere ?? []).map((u) => [u.id as string, u.email as string | null]));
    for (const r of raekker) r.email = r.brugerId ? maskerEmail(map.get(r.brugerId)) : "—";
  } else {
    for (const r of raekker) r.email = "—";
  }
  return { tilstand: "ok", data: raekker };
}

// ------------------------------------------------------------------ fejl

export type FejlGruppe = {
  noegle: string;
  kilde: string;
  besked: string;
  antal: number;
  foerst: string;
  senest: string;
  stier: string[];
  digests: string[];
  brugere: number;
};

export async function hentFejlGrupper(
  admin: Admin,
  nu: number,
  dage: number,
): Promise<Sektion<{ grupper: FejlGruppe[]; iAlt: number; afkortet: boolean }>> {
  const MAKS = 1000;
  const { data, error } = await admin
    .from("drift_fejl")
    .select("id, oprettet_kl, senest_kl, antal, kilde, sti, besked, digest, bruger_id")
    .neq("kilde", "notifikation")
    .gte("senest_kl", new Date(nu - dage * DAG).toISOString())
    .order("senest_kl", { ascending: false })
    .limit(MAKS);
  if (error) return sektion(error, { grupper: [], iAlt: 0, afkortet: false });

  const grupper = new Map<string, FejlGruppe & { brugerSet: Set<string> }>();
  let iAlt = 0;
  for (const r of (data ?? []) as FejlRaekke[]) {
    iAlt += r.antal;
    const noegle = `${r.kilde}\u0000${r.besked}`;
    let g = grupper.get(noegle);
    if (!g) {
      g = {
        noegle,
        kilde: r.kilde,
        besked: r.besked,
        antal: 0,
        foerst: r.oprettet_kl,
        senest: r.senest_kl,
        stier: [],
        digests: [],
        brugere: 0,
        brugerSet: new Set(),
      };
      grupper.set(noegle, g);
    }
    g.antal += r.antal;
    if (r.oprettet_kl < g.foerst) g.foerst = r.oprettet_kl;
    if (r.senest_kl > g.senest) g.senest = r.senest_kl;
    if (r.sti && !g.stier.includes(r.sti) && g.stier.length < 3) g.stier.push(r.sti);
    if (r.digest && !g.digests.includes(r.digest) && g.digests.length < 3) g.digests.push(r.digest);
    if (r.bruger_id) g.brugerSet.add(r.bruger_id);
  }
  const liste = [...grupper.values()]
    .map(({ brugerSet, ...g }) => ({ ...g, brugere: brugerSet.size }))
    .sort((a, b) => (a.senest < b.senest ? 1 : -1));
  return {
    tilstand: "ok",
    data: { grupper: liste, iAlt, afkortet: (data ?? []).length >= MAKS },
  };
}
