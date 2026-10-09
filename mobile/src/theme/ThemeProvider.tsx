import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { dark, light, Palette } from './tokens';
import { storage } from '@/lib/storage';

export type ThemeMode = 'system' | 'light' | 'dark';

type Ctx = { colors: Palette; mode: ThemeMode; setMode: (m: ThemeMode) => void };
const ThemeCtx = createContext<Ctx>({ colors: light, mode: 'system', setMode: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');

  useEffect(() => {
    storage.get('theme').then((v) => {
      if (v === 'light' || v === 'dark' || v === 'system') setModeState(v);
    });
  }, []);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    storage.set('theme', m);
  }, []);

  const colors = (mode === 'system' ? system === 'dark' : mode === 'dark') ? dark : light;
  const value = useMemo(() => ({ colors, mode, setMode }), [colors, mode, setMode]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
