import Link from "next/link";

// Vises inde i admin-panelet, når en side kalder notFound() - også når
// medarbejderen ikke har den rolle, siden kræver (kraevSideRolle).
export default function AdminIkkeFundet() {
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <p className="text-sm font-semibold text-neutral-500">404</p>
      <h1 className="mt-2 text-xl font-bold text-neutral-900">Siden findes ikke</h1>
      <p className="mt-2 text-sm text-neutral-500">
        Siden findes ikke, eller du har ikke adgang til den med din rolle.
      </p>
      <div className="mt-6">
        <Link
          href="/admin"
          className="inline-flex items-center justify-center rounded-lg border border-neutral-300 bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 transition-colors hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          Til oversigten
        </Link>
      </div>
    </div>
  );
}
