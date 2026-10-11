import Link from "next/link";
import { kraevErhvervSide } from "@/lib/adminAuth";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import { KlageKort } from "@/components/admin/dsa/DsaKort";
import { Pille, tid } from "@/components/admin/dsa/DsaDele";
import { erhvervDsaKlageAfgoer } from "@/app/actions/adminErhvervDsa";
import { erUuid } from "@/lib/dsa/link";
import { INHABIL_UKENDT, firmaKlageInhabil, hentFirmaDsaKlage, hentFirmaFor } from "@/lib/dsa/firmaKlager";
import { ERHVERV_DSA_KLAGER as T } from "@/lib/tekster/erhvervDsaKlager";

// Admin → Erhverv → Firmaets klager → én klage. Kun chef og saelger.
// Genbruger DSA-klagekortet (samme visning og knapper som DSA → Klager), men
// afgør via erhvervDsaKlageAfgoer, der kun tager klager over en firmakonto.
// Inhabilitet beregnes her med samme regler som databasen, så knapperne slet
// ikke vises; databasen tjekker det igen.

export const dynamic = "force-dynamic";

export const metadata = { title: "Klage over afgørelse" };

function Tilbage() {
  return (
    <Link href="/admin/erhverv/dsa-klager" className="inline-flex min-h-11 items-center text-sm font-medium text-groen hover:underline">
      ← {T.tilbage}
    </Link>
  );
}

export default async function ErhvervDsaKlageSide({ params }: { params: Promise<{ id: string }> }) {
  const { admin, userId } = await kraevErhvervSide();
  const { id } = await params;

  const k = erUuid(id) ? await hentFirmaDsaKlage(admin, id) : null;
  if (!k) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <Tilbage />
        <p role="alert" className="rounded-xl border border-neutral-200 bg-white p-6 text-sm text-neutral-700">
          {T.ikkeFundet}
        </p>
      </div>
    );
  }

  const [inhabil, firmaer, { data: brugere }] = await Promise.all([
    k.status === "afventer" ? firmaKlageInhabil(admin, k, userId) : Promise.resolve(null),
    hentFirmaFor(admin, [k.afg.bruger_id]),
    admin
      .from("users")
      .select("id, navn")
      .in("id", [k.afg.bruger_id, k.afg.medarbejder_id, k.klager_id, k.afgjort_af].filter((x): x is string => !!x)),
  ]);
  const firma = firmaer.get(k.afg.bruger_id) ?? null;
  const navne = new Map(((brugere ?? []) as { id: string; navn: string | null }[]).map((u) => [u.id, u.navn ?? "Uden navn"]));
  const navn = (x: string | null) => {
    if (!x) return "—";
    if (x === k.afg.bruger_id && firma) return firma.firmanavn;
    return navne.get(x) ?? "Ukendt";
  };
  // Sælger-rollen har kun adgang til Erhverv: firmaet linker til firmasiden.
  const brugerHref = (x: string) =>
    x === k.afg.bruger_id && firma ? `/admin/erhverv/firmaer/${firma.id}` : null;
  const lukket = k.afg.handling === "konto_lukket";

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <Tilbage />
      <AdminSideHoved
        titel={`${k.sagsnummer} · ${firma?.firmanavn ?? "Firma"}`}
        forklaring={`${firma ? `CVR ${firma.cvr} · ` : ""}modtaget ${tid(k.oprettet_kl)}`}
        hoejre={
          <Pille farve={lukket ? "orange" : "blaa"}>
            {lukket ? T.lukket : T.suspenderet}
            {!lukket && ` · ${k.afg.varighed_til ? T.til(tid(k.afg.varighed_til)) : T.permanent}`}
          </Pille>
        }
      />

      {inhabil === INHABIL_UKENDT && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {INHABIL_UKENDT}
        </p>
      )}

      {k.status === "afventer" ? (
        <>
          <KlageKort
            k={k}
            afg={k.afg}
            anm={null}
            navn={navn}
            inhabil={inhabil}
            erAdmin
            erhverv
            som="div"
            afgjort={inhabil === INHABIL_UKENDT}
            afgoerAction={erhvervDsaKlageAfgoer}
            brugerHref={brugerHref}
          />
          {lukket && <p className="text-sm text-neutral-600">{T.abonnementNote}</p>}
        </>
      ) : (
        <>
          <KlageKort
            k={k}
            afg={k.afg}
            anm={null}
            navn={navn}
            inhabil={null}
            erAdmin
            erhverv
            som="div"
            afgjort
            afgoerAction={erhvervDsaKlageAfgoer}
            brugerHref={brugerHref}
          />
          <section className="rounded-[14px] border border-kant bg-white p-4 text-sm sm:p-5">
            <p className="flex flex-wrap items-center gap-2">
              <Pille farve={k.udfald === "medhold" ? "groen" : "neutral"}>
                {k.udfald === "medhold" ? T.medhold : T.fastholdt}
              </Pille>
              {k.afgjort_kl && <span className="text-neutral-600">{T.afgjortAf(navn(k.afgjort_af), tid(k.afgjort_kl))}</span>}
            </p>
            {k.svar && (
              <>
                <h2 className="mt-3 font-sans text-xs font-semibold uppercase tracking-wide text-neutral-600">{T.svar}</h2>
                <p className="mt-1 whitespace-pre-wrap break-words text-neutral-800">{k.svar}</p>
              </>
            )}
          </section>
        </>
      )}

    </div>
  );
}
