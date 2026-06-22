import Link from "next/link";

export default async function BetalSuccessPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="flex flex-1 items-center justify-center bg-white px-4 py-10">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-semibold text-neutral-900">
          Tak for din betaling!
        </h1>
        <p className="mt-3 text-sm text-neutral-600">
          Beløbet opbevares sikkert af Hamr, indtil du har modtaget og
          godkendt varen. Sælger får først pengene udbetalt herefter.
        </p>

        <Link
          href={`/auktion/${id}`}
          className="mt-6 inline-block rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-[#d62b38]"
        >
          Tilbage til auktionen
        </Link>
      </div>
    </main>
  );
}
