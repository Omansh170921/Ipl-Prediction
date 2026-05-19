/**
 * Theme "colours" — Office-style named palettes (dark + light tokens in CSS).
 * `swatch`: two colours for the picker chip (135deg gradient).
 */
export const COLOR_PRESETS = [
  { id: 'pitch', label: 'Pitch green', swatch: ['#0d2818', '#22c55e'] },
  { id: 'ocean', label: 'Ocean teal', swatch: ['#0c4a6e', '#2dd4bf'] },
  { id: 'twilight', label: 'Twilight violet', swatch: ['#1e1b4b', '#a78bfa'] },
  { id: 'sunset', label: 'Sunset orange', swatch: ['#431407', '#fb923c'] },
  { id: 'ruby', label: 'Ruby rose', swatch: ['#4c0519', '#fb7185'] },
  { id: 'indigo', label: 'Indigo blue', swatch: ['#172554', '#60a5fa'] },
  { id: 'slate', label: 'Slate gray', swatch: ['#1e293b', '#94a3b8'] },
  { id: 'steel', label: 'Steel blue-gray', swatch: ['#1e293b', '#64748b'] },
  { id: 'forest', label: 'Forest green', swatch: ['#052e16', '#15803d'] },
  { id: 'lime', label: 'Lime bright', swatch: ['#1a2e05', '#84cc16'] },
  { id: 'azure', label: 'Azure sky', swatch: ['#0c4a6e', '#38bdf8'] },
  { id: 'cobalt', label: 'Cobalt navy', swatch: ['#172554', '#3b82f6'] },
  { id: 'cyan', label: 'Cyan aqua', swatch: ['#164e63', '#22d3ee'] },
  { id: 'plum', label: 'Plum purple', swatch: ['#3b0764', '#c084fc'] },
  { id: 'orchid', label: 'Orchid lilac', swatch: ['#4c1d95', '#d8b4fe'] },
  { id: 'coral', label: 'Coral pink', swatch: ['#7f1d1d', '#fb7185'] },
  { id: 'marigold', label: 'Marigold gold', swatch: ['#713f12', '#facc15'] },
  { id: 'copper', label: 'Copper bronze', swatch: ['#451a03', '#d97706'] },
  { id: 'moss', label: 'Moss olive', swatch: ['#292524', '#65a30d'] },
  { id: 'graphite', label: 'Graphite charcoal', swatch: ['#0f172a', '#64748b'] },
  { id: 'crimson', label: 'Crimson wine', swatch: ['#450a0a', '#f87171'] },
  { id: 'magenta', label: 'Magenta fuchsia', swatch: ['#701a75', '#e879f9'] },
  { id: 'cherry', label: 'Cherry red', swatch: ['#7f1d1d', '#ef4444'] },
  { id: 'mint', label: 'Mint fresh', swatch: ['#134e4a', '#5eead4'] },
  { id: 'saffron', label: 'Saffron', swatch: ['#5c1d06', '#ff9933'] },
];

export const COLOR_PRESET_IDS = COLOR_PRESETS.map((p) => p.id);

/** First row — “Theme colours” (Office-style grouping). */
export const THEME_SWATCH_PRESETS = COLOR_PRESETS.slice(0, 12);

/** Second row — “Standard colours”. */
export const STANDARD_SWATCH_PRESETS = COLOR_PRESETS.slice(12);

export function isValidColorPreset(id) {
  return typeof id === 'string' && COLOR_PRESET_IDS.includes(id);
}
