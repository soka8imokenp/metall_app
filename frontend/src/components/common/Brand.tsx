import React from 'react';
import markUrl from '../../assets/brand/metall-asia-mark.png';
import wordmarkUrl from '../../assets/brand/metall-asia-wordmark.png';

/**
 * Знак и написание названия — файлы заказчика, а не наш набор шрифтом: их
 * шрифт нам не передавали, подбирать похожий значило бы выдать чужую букву
 * за их. Поэтому название стоит картинкой.
 *
 * В присланном файле «METALL» и «ASIA» стоят в две строки, а нужна одна.
 * Слова вырезаны из него же и составлены в ряд по базовой линии, а не по
 * нижнему краю рамки: у «S» и «A» он на три точки ниже базовой, и по рамке
 * слова встали бы уступом. Пробел между словами — 0,28 высоты прописной,
 * как в наборе.
 *
 * Картинка при этом не цветная: у надписи оставлена только прозрачность, а
 * цвет даёт `bg-*` через маску. Так она чёрная в светлой теме и белая в
 * тёмной одним файлом, а не двумя. Источники — jpg от заказчика, белый фон
 * из них убран (знак — заливкой от углов, надпись — по темноте пикселя).
 */

export const BrandMark: React.FC<{ className?: string }> = ({ className = 'h-14' }) => (
  <img
    src={markUrl}
    alt=""
    aria-hidden="true"
    draggable={false}
    className={`w-auto select-none ${className}`}
  />
);

export const BrandWordmark: React.FC<{ className?: string }> = ({ className = 'h-10' }) => (
  <span
    role="img"
    aria-label="METALL ASIA"
    style={{
      WebkitMaskImage: `url(${wordmarkUrl})`,
      maskImage: `url(${wordmarkUrl})`,
      WebkitMaskSize: 'contain',
      maskSize: 'contain',
      WebkitMaskRepeat: 'no-repeat',
      maskRepeat: 'no-repeat',
      WebkitMaskPosition: 'center',
      maskPosition: 'center',
      // Пропорция файла: высоту задаёт класс, ширина считается от неё.
      aspectRatio: '344 / 31',
    }}
    className={`block select-none bg-zinc-950 dark:bg-zinc-50 ${className}`}
  />
);
