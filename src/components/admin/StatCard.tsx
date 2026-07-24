interface StatCardProps {
  title: string;
  value: string | number;
  icon: string;
  color?: string;
}

export default function StatCard({ title, value, icon, color = "#E63946" }: StatCardProps) {
  return (
    <div className="bg-white rounded-xl border border-neutral-200 p-5 flex items-center gap-4">
      <div
        className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}18` }}
      >
        <svg
          className="w-6 h-6"
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
        </svg>
      </div>
      <div>
        <p className="text-xs text-neutral-500 font-medium uppercase tracking-wide">{title}</p>
        <p className="text-2xl font-bold text-neutral-900 mt-0.5">{value}</p>
      </div>
    </div>
  );
}
