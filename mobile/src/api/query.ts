import { useQuery, UseQueryOptions } from '@tanstack/react-query';
import { api, apiFull } from './client';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';

/**
 * Чтение с кэшем. Ключ включает компанию и язык: переключили компанию — это
 * другие данные, а не тот же список. Кэш переживает перезапуск, поэтому без
 * связи экран показывает последнее загруженное (см. NetworkProvider).
 */
export function useApi<T = any>(
  path: string | null,
  query?: Record<string, string | number | boolean | undefined | null>,
  options?: Partial<UseQueryOptions<T, Error, T, any[]>>,
) {
  const { companyKey, user } = useAuth();
  const { locale } = useI18n();
  return useQuery<T, Error, T, any[]>({
    queryKey: ['api', user?.uid, companyKey, locale, path, query ?? {}],
    queryFn: ({ signal }) => api<T>(path!, { query, signal }),
    enabled: !!path && !!user,
    ...options,
  });
}

/** То же, но с мета-данными ответа (общее число, курсор). */
export function useApiFull<T = any>(
  path: string | null,
  query?: Record<string, string | number | boolean | undefined | null>,
) {
  const { companyKey, user } = useAuth();
  const { locale } = useI18n();
  return useQuery<{ data: T; meta: any }, Error, { data: T; meta: any }, any[]>({
    queryKey: ['apiFull', user?.uid, companyKey, locale, path, query ?? {}],
    queryFn: ({ signal }) => apiFull<T>(path!, { query, signal }),
    enabled: !!path && !!user,
  });
}
