/**
 * Токены. Карточки чуть светлее фона и стоят на мягкой тени (без светлого
 * «свечения» — его убрали по просьбе заказчика). Вдавленное — то, во что вводят
 * (поля, дорожка переключателя) и что сейчас нажато: там тень внутренняя.
 *
 * Цвет бренда — красный знака METALL ASIA, он точечный: активная вкладка,
 * важная цифра, шапка. Текст — тёмный графит с холодным оттенком.
 */
export type Palette = {
  canvas: string;
  surface: string;
  muted: string;
  card: string;
  border: string;
  borderStrong: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentFg: string;
  brand: string;
  success: string;
  successBg: string;
  warning: string;
  warningBg: string;
  danger: string;
  dangerBg: string;
  info: string;
  infoBg: string;
  overlay: string;
  bandFrom: string;
  bandTo: string;
  graphite: string;
  heroFrom: string;
  heroTo: string;
  /** Тени soft UI: строки CSS box-shadow — их понимают и RN (новая архитектура), и веб. */
  raised: string;
  raisedSm: string;
  raisedLg: string;
  inset: string;
  insetSm: string;
  isDark: boolean;
};

export const light: Palette = {
  canvas: '#e7e9ee',
  surface: '#e7e9ee',
  muted: '#dde0e6',
  card: '#f0f1f4',
  border: 'rgba(160,166,180,0.28)',
  borderStrong: 'rgba(160,166,180,0.5)',
  text: '#1b1e26',
  textSecondary: '#626876',
  textMuted: '#959baa',
  accent: '#1f222a',
  accentFg: '#f4f5f8',
  brand: '#ce1f3c',
  success: '#17864a',
  successBg: 'rgba(23,134,74,0.12)',
  warning: '#a8620a',
  warningBg: 'rgba(214,140,20,0.16)',
  danger: '#c21d38',
  dangerBg: 'rgba(206,31,60,0.11)',
  info: '#3c4250',
  infoBg: 'rgba(60,66,80,0.09)',
  overlay: 'rgba(27,30,38,0.38)',
  bandFrom: '#d4203f',
  bandTo: '#8a1127',
  graphite: '#1f222a',
  heroFrom: '#1f222a',
  heroTo: '#121419',
  raised: '0px 6px 16px rgba(110,118,138,0.20)',
  raisedSm: '0px 3px 8px rgba(110,118,138,0.22)',
  raisedLg: '0px 12px 30px rgba(110,118,138,0.26)',
  inset: 'inset 4px 4px 9px rgba(152,160,178,0.45), inset -4px -4px 9px rgba(255,255,255,0.9)',
  insetSm: 'inset 2px 2px 5px rgba(152,160,178,0.42), inset -2px -2px 5px rgba(255,255,255,0.88)',
  isDark: false,
};

export const dark: Palette = {
  canvas: '#1b1d22',
  surface: '#1b1d22',
  muted: '#262930',
  card: '#23262d',
  border: 'rgba(255,255,255,0.05)',
  borderStrong: 'rgba(255,255,255,0.1)',
  text: '#eceef2',
  textSecondary: '#9ba0ab',
  textMuted: '#6c717d',
  accent: '#eceef2',
  accentFg: '#1c1e24',
  brand: '#ef4460',
  success: '#4ade80',
  successBg: 'rgba(74,222,128,0.12)',
  warning: '#fbbf24',
  warningBg: 'rgba(251,191,36,0.12)',
  danger: '#f87171',
  dangerBg: 'rgba(248,113,113,0.12)',
  info: '#c9ccd4',
  infoBg: 'rgba(255,255,255,0.06)',
  overlay: 'rgba(0,0,0,0.55)',
  bandFrom: '#b81d38',
  bandTo: '#560a19',
  graphite: '#14161a',
  heroFrom: '#262931',
  heroTo: '#16181d',
  raised: '0px 6px 16px rgba(0,0,0,0.42)',
  raisedSm: '0px 3px 8px rgba(0,0,0,0.4)',
  raisedLg: '0px 12px 30px rgba(0,0,0,0.5)',
  inset: 'inset 4px 4px 9px rgba(0,0,0,0.55), inset -3px -3px 8px rgba(255,255,255,0.045)',
  insetSm: 'inset 2px 2px 5px rgba(0,0,0,0.5), inset -2px -2px 5px rgba(255,255,255,0.04)',
  isDark: true,
};

export const radius = { sm: 8, md: 14, lg: 20, xl: 28, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
