import React from 'react';
import { Info } from 'lucide-react';
import {
  parseHelpMarkdown,
  type HelpBlock,
  type HelpInline,
} from '../../help/markdown.ts';

/**
 * Рисует разобранную статью обычными узлами React.
 *
 * `dangerouslySetInnerHTML` здесь нет и быть не должно: статья — это текст из
 * файла, и превращать его в разметку страницы незачем. Чего разбор не знает,
 * то доедет текстом.
 *
 * Картинок статья не содержит (заказчик, 07.10): снимки экрана из справки
 * убраны, и рисовать здесь нечего.
 */

const Inline: React.FC<{ nodes: HelpInline[]; onOpen: (slug: string) => void }> = ({
  nodes,
  onOpen,
}) => (
  <>
    {nodes.map((n, i) => {
      switch (n.kind) {
        case 'strong':
          return (
            <strong key={i} className="font-semibold text-zinc-950 dark:text-zinc-50">
              {n.text}
            </strong>
          );
        case 'code':
          return (
            <code
              key={i}
              className="font-mono text-[11px] px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 break-all"
            >
              {n.text}
            </code>
          );
        case 'article':
          return (
            <button
              key={i}
              type="button"
              data-help-link={n.slug}
              onClick={() => onOpen(n.slug)}
              className="underline decoration-dotted underline-offset-2 text-zinc-900 dark:text-zinc-100 hover:text-[#d12348] cursor-pointer"
            >
              {n.text}
            </button>
          );
        case 'link':
          return (
            <a
              key={i}
              href={n.href}
              target="_blank"
              rel="noreferrer noopener"
              className="underline decoration-dotted underline-offset-2 text-zinc-900 dark:text-zinc-100 hover:text-[#d12348]"
            >
              {n.text}
            </a>
          );
        default:
          return <React.Fragment key={i}>{n.text}</React.Fragment>;
      }
    })}
  </>
);

const Block: React.FC<{ block: HelpBlock; onOpen: (slug: string) => void }> = ({
  block,
  onOpen,
}) => {
  switch (block.kind) {
    case 'heading':
      return block.level === 2 ? (
        <h3 className="text-[13px] font-semibold text-zinc-950 dark:text-zinc-50 mt-2 break-words">
          <Inline nodes={block.inline} onOpen={onOpen} />
        </h3>
      ) : (
        <h4 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200 mt-1 break-words">
          <Inline nodes={block.inline} onOpen={onOpen} />
        </h4>
      );

    case 'paragraph':
      return (
        <p className="text-xs leading-relaxed text-zinc-700 dark:text-zinc-300 break-words">
          <Inline nodes={block.inline} onOpen={onOpen} />
        </p>
      );

    case 'list':
      // Шаги по порядку — именно `ol`: нумерацию рисует браузер, а не текст
      // статьи, и вставленный в середину шаг не требует перенумерации руками.
      return block.ordered ? (
        <ol className="list-decimal pl-5 flex flex-col gap-1.5 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
          {block.items.map((it, i) => (
            <li key={i} className="break-words">
              <Inline nodes={it} onOpen={onOpen} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="list-disc pl-5 flex flex-col gap-1.5 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
          {block.items.map((it, i) => (
            <li key={i} className="break-words">
              <Inline nodes={it} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      );

    case 'note':
      return (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
          <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-200 break-words min-w-0">
            <Inline nodes={block.inline} onOpen={onOpen} />
          </p>
        </div>
      );

    case 'code':
      return (
        <pre className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-3 overflow-x-auto">
          <code className="font-mono text-[11px] text-zinc-800 dark:text-zinc-200 whitespace-pre">
            {block.text}
          </code>
        </pre>
      );

    case 'table':
      return (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-xs">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400">
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} className="px-2.5 py-2 text-left font-medium whitespace-nowrap">
                    <Inline nodes={cell} onOpen={onOpen} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className="px-2.5 py-2 align-top text-zinc-700 dark:text-zinc-300">
                      <Inline nodes={cell} onOpen={onOpen} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
};

export const HelpMarkdown: React.FC<{ markdown: string; onOpen: (slug: string) => void }> = ({
  markdown,
  onOpen,
}) => {
  const blocks = React.useMemo(() => parseHelpMarkdown(markdown), [markdown]);
  return (
    <div className="flex flex-col gap-3 min-w-0">
      {blocks.map((b, i) => (
        <Block key={i} block={b} onOpen={onOpen} />
      ))}
    </div>
  );
};
