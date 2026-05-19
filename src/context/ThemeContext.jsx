import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { isValidColorPreset } from '../theme/colorPresets';

const STORAGE_KEY = 'ipl-theme-preference';
const COLOR_STORAGE_KEY = 'ipl-color-preset';

const ThemeContext = createContext(null);

function readStoredPreference() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
    if (raw === 'system') {
      try {
        localStorage.setItem(STORAGE_KEY, 'light');
      } catch {
        /* ignore */
      }
      return 'light';
    }
  } catch {
    /* ignore */
  }
  return 'dark';
}

function readStoredColorPreset() {
  try {
    const raw = localStorage.getItem(COLOR_STORAGE_KEY);
    if (isValidColorPreset(raw)) return raw;
  } catch {
    /* ignore */
  }
  return 'pitch';
}

export function ThemeProvider({ children }) {
  const [preference, setPreferenceState] = useState(readStoredPreference);
  const [colorPreset, setColorPresetState] = useState(readStoredColorPreset);

  useEffect(() => {
    document.documentElement.dataset.theme = preference;
    document.documentElement.dataset.color = colorPreset;
  }, [preference, colorPreset]);

  const setPreference = useCallback((next) => {
    if (next !== 'dark' && next !== 'light') return;
    setPreferenceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const setColorPreset = useCallback((next) => {
    if (!isValidColorPreset(next)) return;
    setColorPresetState(next);
    try {
      localStorage.setItem(COLOR_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(
    () => ({
      preference,
      setPreference,
      colorPreset,
      setColorPreset,
    }),
    [preference, setPreference, colorPreset, setColorPreset],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with provider
export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return ctx;
}
