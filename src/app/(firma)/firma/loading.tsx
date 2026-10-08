// Skelet for alle sider i firma-dashboardet (menuen og toppen står fast i
// layoutet): overskrift og et par kort.
export default function Loading() {
  const blok = "animate-pulse rounded bg-skelet";
  return (
    <div className="mx-auto max-w-[900px] space-y-6" aria-busy="true">
      <span className="sr-only">Indlæser …</span>
      <div className={`h-10 w-64 max-w-full ${blok}`} />
      <div className={`h-5 w-80 max-w-full ${blok}`} />
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i} className="h-56 animate-pulse rounded-[18px] border border-kant bg-white" />
      ))}
    </div>
  );
}
