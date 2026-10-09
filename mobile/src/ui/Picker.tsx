import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Feather } from '@/ui/Icon';
import { useTheme } from '@/theme/ThemeProvider';
import { useI18n } from '@/i18n';
import { Text } from './Text';
import { Pressable } from './Pressable';
import { Sheet } from './Sheet';
import { SearchBar, neu } from './components';

export type Option = { value: string; label: string; hint?: string };

/** Поле-выбор: нажали — открылась панель со списком и поиском. Для коротких списков поиск скрыт. */
export function PickerField({ label, value, options, onChange, placeholder, disabled, searchable }: { label: string; value: string | null; options: Option[]; onChange: (v: string) => void; placeholder?: string; disabled?: boolean; searchable?: boolean }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const sel = options.find((o) => o.value === value);
  const showSearch = searchable ?? options.length > 8;
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s ? options.filter((o) => (o.label + ' ' + (o.hint ?? '')).toLowerCase().includes(s)) : options;
    return list.slice(0, 80);
  }, [options, q]);

  return (
    <View style={{ gap: 6 }}>
      <Text variant="callout" tone="secondary" style={{ fontWeight: '600', paddingLeft: 4 }}>{label}</Text>
      <Pressable
        onPress={disabled ? undefined : () => setOpen(true)}
        pressedStyle={neu(colors, 'inset')}
        scaleTo={0.99}
        style={[{ minHeight: 52, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 11, backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center', gap: 8, opacity: disabled ? 0.5 : 1 }, neu(colors, 'raisedSm')]}
      >
        <View style={{ flex: 1 }}>
          <Text variant="body" tone={sel ? 'primary' : 'muted'} style={{ fontWeight: '500', fontSize: 15 }} numberOfLines={2}>{sel?.label ?? placeholder ?? '—'}</Text>
          {!!sel?.hint && <Text variant="caption" tone="secondary" numberOfLines={1}>{sel.hint}</Text>}
        </View>
        <Feather name="chevron-down" size={18} color={colors.textMuted} />
      </Pressable>
      <Sheet visible={open} onClose={() => setOpen(false)} title={label} tall>
        {showSearch && <View style={{ marginHorizontal: -20 }}><SearchBar value={q} onChange={setQ} placeholder={t('search')} /></View>}
        <View style={{ gap: 12, paddingBottom: 4 }}>
          {filtered.map((o) => {
            const on = o.value === value;
            return (
              <Pressable
                key={o.value}
                onPress={() => { onChange(o.value); setOpen(false); setQ(''); }}
                pressedStyle={neu(colors, 'insetSm')}
                scaleTo={0.985}
                style={[{ paddingVertical: 14, paddingHorizontal: 16, borderRadius: 16, backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center', gap: 10 }, neu(colors, on ? 'inset' : 'raisedSm')]}
              >
                <View style={{ flex: 1 }}>
                  <Text variant="callout" style={{ color: on ? colors.brand : colors.text, fontWeight: on ? '700' : '600', fontSize: 14 }}>{o.label}</Text>
                  {!!o.hint && <Text variant="caption" tone="secondary" numberOfLines={1}>{o.hint}</Text>}
                </View>
                {on && <Feather name="check" size={18} color={colors.brand} strokeWidth={2.4} />}
              </Pressable>
            );
          })}
          {filtered.length === 0 && <Text tone="secondary" style={{ textAlign: 'center', padding: 20 }}>{t('empty')}</Text>}
        </View>
      </Sheet>
    </View>
  );
}
