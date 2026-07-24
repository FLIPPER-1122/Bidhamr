interface BarChartProps {
  data: { label: string; value: number }[];
  title?: string;
}

export default function BarChart({ data, title }: BarChartProps) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const chartHeight = 120;
  const labelAreaHeight = 32; // plads til roterede labels
  const barWidth = 10;
  const gap = 6;
  const totalWidth = data.length * (barWidth + gap);

  return (
    <div className="bg-white rounded-xl border border-neutral-200 p-5">
      {title && <p className="text-sm font-semibold text-neutral-700 mb-4">{title}</p>}
      {data.length === 0 ? (
        <div className="flex items-center justify-center h-32 text-neutral-400 text-sm">
          Ingen data
        </div>
      ) : (
        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${Math.max(totalWidth, 300)} ${chartHeight + labelAreaHeight}`}
            width="100%"
          >
            {data.map((d, i) => {
              const barH = Math.max(2, (d.value / max) * chartHeight);
              const x = i * (barWidth + gap);
              const y = chartHeight - barH;
              // Vis kun hver 5. label for at undgå overlap
              const visLabel = i % 5 === 0;

              return (
                <g key={i}>
                  <rect
                    x={x}
                    y={y}
                    width={barWidth}
                    height={barH}
                    fill="#E63946"
                    rx={2}
                    opacity={0.85}
                  />
                  {d.value > 0 && (
                    <text
                      x={x + barWidth / 2}
                      y={y - 4}
                      textAnchor="middle"
                      fontSize={8}
                      fill="#6b7280"
                    >
                      {d.value}
                    </text>
                  )}
                  {visLabel && (
                    <text
                      x={x + barWidth / 2}
                      y={chartHeight + 6}
                      textAnchor="end"
                      fontSize={8}
                      fill="#9ca3af"
                      transform={`rotate(-45, ${x + barWidth / 2}, ${chartHeight + 6})`}
                    >
                      {d.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
}
