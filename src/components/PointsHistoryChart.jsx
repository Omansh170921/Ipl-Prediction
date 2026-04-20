/**
 * Lightweight SVG line chart for cumulative points over completed matches (no extra dependencies).
 */
export default function PointsHistoryChart({ series, height = 200 }) {
  if (!Array.isArray(series) || series.length === 0) {
    return <p className="muted points-history-chart-empty">No series to display.</p>;
  }
  const first = series.find((s) => s.points?.length);
  if (!first?.points?.length) {
    return <p className="muted points-history-chart-empty">No data to chart.</p>;
  }

  const n = first.points.length;
  for (const s of series) {
    if (!s.points || s.points.length !== n) {
      return <p className="muted points-history-chart-empty">Chart series length mismatch.</p>;
    }
  }

  const W = 520;
  const H = height;
  const padL = 48;
  const padR = 14;
  const padT = 20;
  const padB = 52;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const allY = series.flatMap((s) => s.points.map((p) => Number(p.y)));
  let yMin = Math.min(0, ...allY);
  let yMax = Math.max(...allY, yMin + 1);
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const yPad = (yMax - yMin) * 0.08;
  yMin -= yPad;
  yMax += yPad;

  const xAt = (i) => padL + (n <= 1 ? innerW / 2 : (i / Math.max(1, n - 1)) * innerW);
  const yAt = (y) => padT + innerH - ((Number(y) - yMin) / (yMax - yMin)) * innerH;

  const paths = series.map((s) => {
    const d = s.points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(p.y)}`)
      .join(' ');
    return { ...s, d };
  });

  const xLabels = first.points.map((p) => p.xLabel || p.x || '—');
  const tickEvery = n <= 8 ? 1 : Math.ceil(n / 8);

  return (
    <div className="points-history-chart-wrap">
      <svg
        className="points-history-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Points history chart"
      >
        {/* grid */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = padT + innerH * (1 - t);
          return (
            <line
              key={t}
              x1={padL}
              y1={y}
              x2={padL + innerW}
              y2={y}
              className="points-history-chart-grid"
            />
          );
        })}
        {/* zero line if in range */}
        {yMin < 0 && yMax > 0 && (
          <line
            x1={padL}
            y1={yAt(0)}
            x2={padL + innerW}
            y2={yAt(0)}
            className="points-history-chart-zero"
          />
        )}
        {paths.map((s) => (
          <path
            key={s.id || s.label}
            d={s.d}
            fill="none"
            stroke={s.color || 'var(--accent, #3b82f6)'}
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {paths.map((s) =>
          s.points.map((p, i) => (
            <circle
              key={`${s.id || s.label}-${i}`}
              cx={xAt(i)}
              cy={yAt(p.y)}
              r="4"
              fill={s.color || 'var(--accent, #3b82f6)'}
              className="points-history-chart-dot"
              stroke="var(--card-bg, #fff)"
            />
          ))
        )}
        {/* Y axis labels */}
        {[0, 0.5, 1].map((t) => {
          const val = yMin + (yMax - yMin) * (1 - t);
          const y = padT + innerH * t;
          return (
            <text
              key={t}
              x={padL - 6}
              y={y + 4}
              textAnchor="end"
              className="points-history-chart-axis-text"
            >
              {Number.isInteger(val) ? val : val.toFixed(1)}
            </text>
          );
        })}
        {/* X labels */}
        {first.points.map((_, i) =>
          i % tickEvery === 0 || i === n - 1 ? (
            <text
              key={i}
              x={xAt(i)}
              y={H - 10}
              textAnchor="middle"
              className="points-history-chart-x-text"
            >
              {xLabels[i]}
            </text>
          ) : null
        )}
      </svg>
      <ul className="points-history-chart-legend">
        {series.map((s) => (
          <li key={s.id || s.label}>
            <span className="points-history-chart-legend-swatch" style={{ background: s.color }} aria-hidden />
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
