// Keep provider/storage amounts in USD; convert only at the presentation edge.
const centsNumber = new Intl.NumberFormat('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
export function formatCents(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd * 100) || usd < 0) return 'Unavailable';
  if (usd > 0 && usd * 100 < 0.01) return '<¢0.01';
  return '¢' + centsNumber.format(usd * 100);
}

export function modelCostSummary(model) {
  const cost = model.referenceCost;
  return cost && Number.isFinite(cost.usd) && cost.usd >= 0
    ? `${formatCents(cost.usd)} / image · ${cost.billingConfirmed ? 'Billing confirmed' : 'Estimate'}`
    : 'Price unavailable · Estimate';
}

export function matchingReferenceModel(model, catalog) {
  // Historical aliases may have changed upstream providers or models.
  return catalog.find(candidate => candidate.id === model.id && candidate.provider === model.provider && candidate.model === model.model) ?? {...model, referenceCost: null};
}

// Historical estimate explanations may still contain dollar-denominated rates.
export function formatPriceText(text) {
  return typeof text === 'string' ? text.replace(/\$([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)(?: USD)?/g,
    (_, amount) => formatCents(Number(amount.replaceAll(',', '')))) : text;
}

const priceLabels = {estimatedInputUsd: 'Estimated input cost', estimatedOutputUsd: 'Estimated output cost',
  estimatedTotalUsd: 'Estimated total cost', reportedCostUsd: 'Reported cost', unitPriceUsd: 'Unit price'};
export function displayMetric(key, value) {
  if (key.endsWith('Usd')) return [(priceLabels[key] ?? key.slice(0, -3)) + ' (US cents)', value == null ? null : formatCents(value)];
  if (key === 'estimateBasis') return ['Estimate basis', formatPriceText(value)];
  return [key, value];
}

export function exportComparison(comparison) {
  return {...comparison, priceUnit: 'US cents', cells: comparison.cells.map(cell => ({...cell,
    ...(cell.metrics ? {metrics: Object.fromEntries(Object.entries(cell.metrics).map(([key, value]) =>
      key.endsWith('Usd') ? [key.slice(0, -3) + 'Cents', value == null ? null : value * 100]
        : [key, key === 'estimateBasis' ? formatPriceText(value) : value]))} : {})}))};
}
