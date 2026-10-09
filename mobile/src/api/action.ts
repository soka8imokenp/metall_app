import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newKey } from './client';
import { useToast } from '@/ui/Toast';
import { useOnline } from '@/lib/network';
import { useI18n } from '@/i18n';

/**
 * Изменение данных. Работает только онлайн (режим «только онлайн»), ключ
 * идемпотентности создаётся один раз на форму: если запрос ушёл, ответ потерялся,
 * а человек нажал ещё раз — второй операции не будет. После успеха кэш
 * списков сбрасывается, и экраны перечитывают свежее.
 */
export function useAction() {
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());

  const run = useCallback(
    async <T = any>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, opts?: { success?: string; silent?: boolean }): Promise<T | null> => {
      if (!online) {
        toast.show(t('needsNetwork'), 'error');
        return null;
      }
      setBusy(true);
      setError(null);
      try {
        const r = await api<T>(path, { method, body, idempotencyKey: key.current });
        // успех: следующая форма — новый ключ
        key.current = newKey();
        await qc.invalidateQueries({ queryKey: ['api'] });
        await qc.invalidateQueries({ queryKey: ['apiFull'] });
        if (opts?.success) toast.show(opts.success, 'success');
        return r;
      } catch (e) {
        const msg = e instanceof ApiError ? (e.isNetwork ? t('needsNetwork') : e.message) : String(e);
        setError(msg);
        if (!opts?.silent) toast.show(msg, 'error');
        return null;
      } finally {
        setBusy(false);
      }
    },
    [online, qc, toast, t],
  );

  const reset = useCallback(() => {
    key.current = newKey();
    setError(null);
  }, []);

  return { run, busy, error, reset };
}
