import React, { useState } from 'react';
import GradientWaves from './GradientWaves';
import { useApp } from '../../context/AppContext';

/**
 * Фон страницы входа.
 *
 * Волны рисует WebGL2, и это единственное место в системе, где картинка
 * зависит от видеокарты. Поэтому здесь три уровня: анимация, если браузер
 * умеет и человек не просил меньше движения; неподвижный градиент, если не
 * умеет или просил; и он же, если шейдер всё-таки упал — форму входа ронять
 * из-за фона нельзя, без неё в систему не попасть.
 *
 * Цвета серые: система монохромная, и фон входа не повод заводить в ней
 * второй цвет. Красный остаётся там, где он и есть у заказчика, — на знаке.
 */

const PALETTE = {
  light: { horizonColor: '#ffffff', waveColor: '#ededf0', crestColor: '#71717a' },
  dark: { horizonColor: '#09090b', waveColor: '#141417', crestColor: '#8b8b93' },
} as const;

/** Неподвижная замена: то же уплотнение к нижнему краю, тот же фон темы. */
const STILL =
  'absolute inset-0 bg-zinc-50 dark:bg-[#09090b] ' +
  'bg-[radial-gradient(130%_90%_at_50%_115%,rgba(9,9,11,0.12)_0%,rgba(9,9,11,0)_62%)] ' +
  'dark:bg-[radial-gradient(130%_90%_at_50%_115%,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0)_62%)]';

/**
 * Поверх волн — вуаль: без неё карточка входа читается через гребень волны,
 * а контраст текста падает ниже 4.5:1.
 */
const SCRIM =
  'absolute inset-0 bg-gradient-to-b from-white/55 via-white/25 to-white/72 ' +
  'dark:from-[#09090b]/60 dark:via-[#09090b]/30 dark:to-[#09090b]/72';

const canAnimate = () => {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
};

class Boundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export const LoginBackdrop: React.FC = () => {
  const { theme } = useApp();
  // Решение принимается один раз: переключать фон посреди сеанса не на что.
  const [animate] = useState(canAnimate);
  const [detail] = useState<'low' | 'medium'>(() =>
    typeof window !== 'undefined' && window.innerWidth < 640 ? 'low' : 'medium',
  );
  const palette = PALETTE[theme === 'dark' ? 'dark' : 'light'];
  const still = <div className={STILL} />;

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
      {animate ? (
        <Boundary fallback={still}>
          <GradientWaves
            {...palette}
            detail={detail}
            speed={0.4}
            amplitude={3}
            waveScale={0.6}
            waveRatio={0.9}
            swell={35}
            turbulence={20}
            tilt={1.11}
            zoom={1}
            height={5.5}
            fogDepth={34}
            grain
            grainIntensity={0.05}
            mouseInteraction
            parallaxStrength={0.5}
            className="absolute inset-0"
          />
        </Boundary>
      ) : (
        still
      )}
      <div className={SCRIM} />
    </div>
  );
};
