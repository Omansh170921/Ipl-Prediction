import { useId } from 'react';
import { to2Decimals } from '../utils/points';

const VB = { w: 420, h: 200 };
const PAD = { l: 46, r: 14, t: 18, b: 36 };

const STROKE = {
  match: '#1b5e20',
  insight: '#6d28d9',
};

/**
 * Line + area chart of cumulative points over ordered steps (matches).
 * @param {Object} props
 * @param {string} props.caption - Heading shown above the chart
 * @param {number[]} props.values - Cumulative totals in chronological order (oldest first)
 * @param {'match' | 'insight'} [props.variant='match']
 */
export default function CumulativePointsLineChart({ caption, values, variant = 'match' }) {
  const reactId = useId().replace(/:/g, '');
  const n = Array.isArray(values) ? values.length : 0;
  if (n === 0) return null;

  const nums = values.map((v) => Number(v));
  if (nums.some((x) => Number.isNaN(x))) return null;

  const yMinRaw = Math.min(0, ...nums);
  const yMaxRaw = Math.max(...nums);
  const span = yMaxRaw - yMinRaw;
  const padY = span === 0 ? Math.max(1, Math.abs(yMaxRaw) * 0.08 || 1) : span * 0.08;
  const domainMin = yMinRaw - padY;
  const domainMax = yMaxRaw + padY;
  const domainSpan = domainMax - domainMin || 1;

  const iw = VB.w - PAD.l - PAD.r;
  const ih = VB.h - PAD.t - PAD.b;

  const pts = nums.map((y, i) => {
    const x = n === 1 ? PAD.l + iw / 2 : PAD.l + (i / (n - 1)) * iw;
    const yn = PAD.t + ih - ((y - domainMin) / domainSpan) * ih;
    return { x, y: yn, raw: y };
  });

  const lineD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const baseY = PAD.t + ih;
  const areaD =
    pts.length === 1
      ? `M ${pts[0].x - 6} ${baseY} L ${pts[0].x + 6} ${baseY} L ${pts[0].x + 6} ${pts[0].y} L ${pts[0].x - 6} ${pts[0].y} Z`
      : `M ${pts[0].x} ${baseY} L ${pts.map((p) => `${p.x} ${p.y}`).join(' L ')} L ${pts[pts.length - 1].x} ${baseY} Z`;

  const stroke = STROKE[variant] || STROKE.match;
  const gradId = `cumulative-chart-grad-${variant}-${reactId}`;
  const showDots = n <= 36;
  const yTicks = 4;
  const tickVals = [];
  for (let t = 0; t <= yTicks; t += 1) {
    tickVals.push(domainMin + (t / yTicks) * (domainMax - domainMin));
  }

  const aria = `${caption}. ${n} step(s). Cumulative from ${to2Decimals(nums[0])} to ${to2Decimals(nums[n - 1])}.`;

  return (
    <div className="cumulative-points-chart-wrap">
      {caption ? <p className="cumulative-points-chart-caption">{caption}</p> : null}
      <svg
        className={`cumulative-points-chart-svg cumulative-points-chart-svg--${variant}`}
        viewBox={`0 0 ${VB.w} ${VB.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={aria}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {tickVals.map((tv, i) => {
          const yy = PAD.t + ih - ((tv - domainMin) / domainSpan) * ih;
          return (
            <g key={`g-${i}`}>
              <line
                x1={PAD.l}
                y1={yy}
                x2={PAD.l + iw}
                y2={yy}
                className="cumulative-points-chart-grid"
              />
              <text x={PAD.l - 6} y={yy + 4} textAnchor="end" className="cumulative-points-chart-axis">
                {to2Decimals(tv)}
              </text>
            </g>
          );
        })}

        <path d={areaD} fill={`url(#${gradId})`} className="cumulative-points-chart-area" />
        <path d={lineD} fill="none" stroke={stroke} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />

        {showDots &&
          pts.map((p, i) => (
            <circle key={`d-${i}`} cx={p.x} cy={p.y} r="3.5" fill={stroke} stroke="#fff" strokeWidth="1.2">
              <title>{`After match ${i + 1}: ${to2Decimals(p.raw)} pts`}</title>
            </circle>
          ))}

        <text x={PAD.l + iw / 2} y={VB.h - 8} textAnchor="middle" className="cumulative-points-chart-xlabel">
          Matches (chronological)
        </text>
      </svg>
    </div>
  );
}
