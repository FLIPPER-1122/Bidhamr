import AdminSide from "@/components/admin/AdminSide";

// Indlæsning, der ligner detaljesiden (sidehoved, knapper og to kort).
export default function Loading() {
  return (
    <AdminSide detalje>
      <div aria-busy="true" className="space-y-5">
        <span className="sr-only">Indlæser regningen…</span>
        <div className="space-y-2">
          <div className="h-4 w-28 animate-pulse rounded bg-skelet/70" />
          <div className="h-7 w-64 animate-pulse rounded-md bg-skelet" />
          <div className="h-4 w-full max-w-md animate-pulse rounded bg-skelet/70" />
        </div>
        <div className="h-24 animate-pulse rounded-none bg-skelet/50" />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="h-72 animate-pulse rounded-none bg-skelet/50" />
          <div className="h-72 animate-pulse rounded-none bg-skelet/50" />
        </div>
      </div>
    </AdminSide>
  );
}
