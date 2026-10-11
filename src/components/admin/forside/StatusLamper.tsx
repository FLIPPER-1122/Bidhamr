import Link from "next/link";
import { AdminPrik } from "@/components/admin/AdminBadge";
import type { Lampe } from "@/lib/admin/lamper";

// Små kort med prik + navn + "sidst ok"-tekst (docs/ADMIN-REDESIGN.md 3.2).
// TODO indhold-agenten: en kort forklaring pr. lampe ("hvad betyder gul?").
export default function StatusLamper({ lamper }: { lamper: Lampe[] }) {
  if (lamper.length === 0) return null;
  return (
    <section aria-labelledby="forside-systemer" className="space-y-2.5">
      <h2 id="forside-systemer" className="text-[13px] font-semibold uppercase tracking-[0.06em] text-tekst-svag">
        Systemer
      </h2>
      <ul className="grid grid-cols-2 gap-2.5 md:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
        {lamper.map((l) => {
          const indhold = (
            <>
              <AdminPrik tone={l.tone} className="row-span-2" />
              <b className="text-sm font-semibold text-tekst">{l.navn}</b>
              <small className="text-[12.5px] text-tekst-svag">{l.tekst}</small>
            </>
          );
          const cls =
            "grid h-full grid-cols-[auto_1fr] items-center gap-x-2.5 gap-y-0.5 rounded-xl border border-admin-kant bg-white px-3.5 py-3";
          return (
            <li key={l.navn}>
              {l.href ? (
                <Link href={l.href} className={`${cls} hover:border-kant-staerk focus-visible:outline-2 focus-visible:outline-groen`}>
                  {indhold}
                </Link>
              ) : (
                <div className={cls}>{indhold}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
