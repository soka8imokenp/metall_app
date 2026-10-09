import { useEffect, useState } from 'react';

/**
 * Приложение узнаёт, что на сервере лежит уже другая сборка.
 *
 * Зачем: имена собранных файлов меняются при каждой выкатке, но ссылается на
 * них `index.html`, а его браузер держит у себя. Пока он не переспросит
 * `index.html`, в окне остаётся прежняя сборка — и выкаченные изменения
 * человек не видит, сколько бы раз ни заходил. Просить «нажмите Ctrl+F5» —
 * не решение: так теряется любая выкатка, а заказчик каждый раз думает, что
 * работа не сделана.
 *
 * Как устроено: при сборке версия попадает и внутрь файлов (`__APP_VERSION__`),
 * и в отдельный `version.json` рядом. Открытое окно спрашивает этот файл и
 * сравнивает с той версией, с которой само загрузилось. Разошлись — сборка на
 * сервере новее, и окну пора перезагрузиться.
 *
 * Перезагружаем не сами: человек может стоять в середине заполненной формы, и
 * внезапная перезагрузка стоила бы ему введённого. Поэтому решение за ним —
 * показывается полоса с кнопкой.
 */

/** Версия, с которой загрузилось это окно. Подставляется при сборке. */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/**
 * Как часто спрашивать сервер. Файл крошечный, но и спешить некуда: выкатка
 * случается несколько раз в день, а не в минуту.
 */
const EVERY_MS = 2 * 60 * 1000;

async function serverVersion(): Promise<string | null> {
  try {
    // `no-store` обязателен: иначе браузер ответит собственной копией файла,
    // и проверка версии сама окажется устаревшей.
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    // Сети нет или стенд перезапускается — это не повод предлагать обновление.
    return null;
  }
}

/** `true`, когда на сервере лежит сборка новее открытой. */
export function useUpdateAvailable(): boolean {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (APP_VERSION === 'dev') return;
    let alive = true;

    const check = async () => {
      const remote = await serverVersion();
      if (!alive || !remote) return;
      if (remote !== APP_VERSION) setStale(true);
    };

    void check();
    const timer = setInterval(check, EVERY_MS);
    // Вкладку часто оставляют открытой на сутки: возврат к ней — самый
    // вероятный момент, когда выкатка уже прошла, а окно об этом не знает.
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  return stale;
}
