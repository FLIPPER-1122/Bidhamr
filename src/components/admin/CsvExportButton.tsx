"use client";

interface CsvExportButtonProps {
  data: { email: string; oprettet: string }[];
}

export default function CsvExportButton({ data }: CsvExportButtonProps) {
  const handleExport = () => {
    const header = "Email,Oprettet\n";
    const rows = data
      .map((row) => `${row.email},${new Date(row.oprettet).toLocaleDateString("da-DK")}`)
      .join("\n");
    const csv = header + rows;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "venteliste.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <button
      onClick={handleExport}
      className="flex items-center gap-2 px-4 py-2 text-sm bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 transition-colors text-neutral-700 font-medium"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
      </svg>
      Eksporter CSV
    </button>
  );
}
