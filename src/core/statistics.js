function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const position = q * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

export function robustStats(values) {
  if (values.length === 0) {
    return { samples: 0, minimum: 0, p25: 0, median: 0, p75: 0, maximum: 0, mad: 0, ewma: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const deviations = sorted
    .map((value) => Math.round(Math.abs(value - median)))
    .sort((a, b) => a - b);

  let ewma = values[0];
  for (let i = 1; i < values.length; i += 1) {
    ewma = 0.30 * values[i] + 0.70 * ewma;
  }

  return {
    samples: sorted.length,
    minimum: sorted[0],
    p25: percentile(sorted, 0.25),
    median,
    p75: percentile(sorted, 0.75),
    maximum: sorted.at(-1),
    mad: percentile(deviations, 0.5),
    ewma,
  };
}

export function robustZ(value, stats, madFloor = 1000) {
  if (stats.samples === 0) return 0;
  const scale = 1.4826 * Math.max(stats.mad, madFloor);
  return scale > 0 ? (value - stats.median) / scale : 0;
}
