import AdminSide from "@/components/admin/AdminSide";

// Indlæsning, der ligner firmasiden: sidehoved, statuslinje, hurtighandlinger
// og faner.
export default function Loading() {
  return (
    <AdminSide>
      <div aria-busy="true" aria-label="Indlæser" className="space-y-5">
        <div className="space-y-2">
          <div className="h-4 w-28 animate-pulse bg-skelet/70" />
          <div className="h-7 w-56 animate-pulse bg-skelet" />
          <div className="h-4 w-full max-w-lg animate-pulse bg-skelet/70" />
        </div>
        <div className="grid grid-cols-2 border border-kant bg-white lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2 px-4 py-3">
              <div className="h-3 w-16 animate-pulse bg-skelet/70" />
              <div className="h-5 w-24 animate-pulse bg-skelet" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse border border-kant bg-white" />
          ))}
        </div>
        <div className="flex gap-3 border-b border-kant pb-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-5 w-20 animate-pulse bg-skelet/70" />
          ))}
        </div>
        <div className="h-48 animate-pulse border border-kant bg-white" />
      </div>
    </AdminSide>
  );
}
