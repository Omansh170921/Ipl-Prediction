import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTheme } from '../context/ThemeContext';
import {
  COLOR_PRESETS,
  STANDARD_SWATCH_PRESETS,
  THEME_SWATCH_PRESETS,
} from '../theme/colorPresets';

const APPEARANCE_OPTIONS = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
];

function SwatchGrid({ presets, colorPreset, onPick }) {
  return (
    <div className="theme-color-grid theme-color-grid--picker" role="list">
      {presets.map(({ id, label, swatch }) => (
        <button
          key={id}
          type="button"
          className={`theme-color-swatch${colorPreset === id ? ' theme-color-swatch--active' : ''}`}
          style={{
            '--swatch-a': swatch[0],
            '--swatch-b': swatch[1],
          }}
          title={label}
          aria-label={label}
          aria-pressed={colorPreset === id}
          onClick={() => onPick(id)}
        />
      ))}
    </div>
  );
}

export function ThemeToggle({ variant = 'floating' }) {
  const { preference, setPreference, colorPreset, setColorPreset } = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const dialogId = useId();

  const activePreset = useMemo(
    () => COLOR_PRESETS.find((p) => p.id === colorPreset) ?? COLOR_PRESETS[0],
    [colorPreset],
  );

  const appearanceLabel = preference === 'light' ? 'Light' : 'Dark';

  const triggerSummary = `${activePreset.label} · ${appearanceLabel}`;

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(ev) {
      if (rootRef.current && !rootRef.current.contains(ev.target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(ev) {
      if (ev.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const setAppearance = useCallback(
    (id) => {
      if (id === 'dark' || id === 'light') setPreference(id);
    },
    [setPreference],
  );

  const rootClass =
    variant === 'sidebar'
      ? 'theme-menu theme-menu--sidebar'
      : 'theme-menu theme-menu--floating';

  return (
    <div className={rootClass} ref={rootRef}>
      <button
        type="button"
        className="theme-menu-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? dialogId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="theme-menu-trigger-swatch"
          style={{
            '--swatch-a': activePreset.swatch[0],
            '--swatch-b': activePreset.swatch[1],
          }}
          aria-hidden
        />
        <span className="theme-menu-trigger-text">{triggerSummary}</span>
        <span className="theme-menu-trigger-chevron" aria-hidden>
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div
          className="theme-menu-panel"
          id={dialogId}
          role="dialog"
          aria-label="Themes and colours"
        >
          <div className="theme-menu-section">
            <div className="theme-menu-section-title">Appearance</div>
            <div className="theme-menu-appearance" role="group" aria-label="Light or dark mode">
              {APPEARANCE_OPTIONS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className={`theme-menu-appearance-btn${
                    preference === id ? ' theme-menu-appearance-btn--active' : ''
                  }`}
                  aria-pressed={preference === id}
                  onClick={() => setAppearance(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="theme-menu-divider" role="separator" />

          <div className="theme-menu-section">
            <div className="theme-menu-section-title">Theme colours</div>
            <SwatchGrid
              presets={THEME_SWATCH_PRESETS}
              colorPreset={colorPreset}
              onPick={setColorPreset}
            />
          </div>

          <div className="theme-menu-divider" role="separator" />

          <div className="theme-menu-section">
            <div className="theme-menu-section-title">Standard colours</div>
            <SwatchGrid
              presets={STANDARD_SWATCH_PRESETS}
              colorPreset={colorPreset}
              onPick={setColorPreset}
            />
          </div>
        </div>
      )}
    </div>
  );
}
