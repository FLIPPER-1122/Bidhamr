export default function AdminSager() {
  return (
    <div className="p-6 space-y-5">
      <h1 className="text-2xl font-bold text-neutral-900">Sager</h1>

      <div className="bg-white rounded-xl border border-neutral-200 p-12 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-[#E6394618]">
          <svg className="h-7 w-7" fill="none" stroke="#E63946" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-neutral-900">Kommer snart</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Her vil du kunne oprette og følge sager om brugere, auktioner og
          tvister.
        </p>
      </div>
    </div>
  );
}
