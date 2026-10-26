import AdminSide from "@/components/admin/AdminSide";

// Indlæsning, der ligner en admin-liste: sidehoved, faner og 5 kortrækker.
export default function AdminListeSkelet({ faner = true, raekker = 5 }: { faner?: boolean; raekker?: number }) {
  return (
    <AdminSide>
      <div aria-busy="true" aria-label="Indlæser" className="space-y-5">
        <div className="space-y-2">
          <div className="h-7 w-48 animate-pulse rounded-md bg-skelet" />
          <div className="h-4 w-full max-w-md animate-pulse rounded-md bg-skelet/70" />
        </div>
        {faner && (
          <div className="flex gap-3 border-b border-kant pb-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-5 w-20 animate-pulse rounded-md bg-skelet/70" />
            ))}
          </div>
        )}
        <div className="overflow-hidden rounded-none border border-kant bg-white">
          {Array.from({ length: raekker }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-t border-kant px-4 py-4 first:border-t-0">
              <div className="h-3 w-3 animate-pulse rounded-full bg-skelet" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-2/3 animate-pulse rounded bg-skelet" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-skelet/70" />
              </div>
              <div className="hidden h-9 w-24 animate-pulse rounded-lg bg-skelet/70 sm:block" />
            </div>
          ))}
        </div>
      </div>
    </AdminSide>
  );
}
