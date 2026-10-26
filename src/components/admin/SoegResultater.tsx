import Link from "next/link";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminTom from "@/components/admin/AdminTom";
import { SOEG_TYPE_NAVN, type SoegTraef, type SoegType } from "@/lib/admin/soeg";

// Resultater fra søgningen øverst i admin, grupperet efter type.
// (Ét eneste resultat sendes direkte videre af siden selv.)
export default function SoegResultater({ q, traef, erhverv = false }: { q: string; traef: SoegTraef[]; erhverv?: boolean }) {
  const grupper = new Map<SoegType, SoegTraef[]>();
  for (const t of traef) grupper.set(t.type, [...(grupper.get(t.type) ?? []), t]);

  return (
    <AdminSide detalje>
      <AdminSideHoved
        titel={q ? `Søgning: ${q}` : "Søg"}
        forklaring={
          erhverv
            ? "Søg på firmanavn, CVR, e-mail eller klagenummer."
            : "Søg på navn, e-mail, telefon, id (de første tegn er nok), sporingsnummer eller DSA-sagsnummer."
        }
      />
      {q.trim().length < 2 && !(erhverv && /^\d$/.test(q.trim())) ? (
        <p className="text-sm text-tekst-daempet">Skriv mindst 2 tegn.</p>
      ) : traef.length === 0 ? (
        <AdminTom ok={false} tekst={`Intet fundet for "${q}". Prøv en del af e-mailen, navnet eller id'et.`} />
      ) : (
        <div className="space-y-5">
          {[...grupper.entries()].map(([type, liste]) => (
            <section key={type} aria-labelledby={`soeg-${type}`} className="space-y-2">
              <h2 id={`soeg-${type}`} className="text-[13px] font-semibold uppercase tracking-[0.06em] text-tekst-svag">
                {SOEG_TYPE_NAVN[type]} ({liste.length})
              </h2>
              <ul className="overflow-hidden rounded-none border border-admin-kant bg-white">
                {liste.map((t) => (
                  <li key={`${t.type}-${t.id}`} className="border-t border-admin-kant first:border-t-0">
                    <Link
                      href={t.href}
                      className="flex min-h-14 items-center justify-between gap-3 px-4 py-3 hover:bg-admin-bg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-groen"
                    >
                      <span className="min-w-0">
                        <span className="block break-words font-semibold text-tekst">{t.titel}</span>
                        {t.under && <span className="block break-words text-sm text-tekst-daempet">{t.under}</span>}
                      </span>
                      <span aria-hidden="true" className="text-tekst-svag">→</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </AdminSide>
  );
}
