import React, { useState } from 'react';
import { View } from 'react-native';
import { Feather } from '@/ui/Icon';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';
import { Pressable } from './Pressable';
import { Text } from './Text';
import { Sheet } from './Sheet';
import { neu } from './components';

/** Выбор компании: одна из доступных или «Обе компании» (заголовок не шлём). */
export function CompanyChip() {
  const { companies, companyKey, company, setCompanyKey } = useAuth();
  const { t, pick } = useI18n();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  if (companies.length < 2) return null;
  const short = (c: any) => (c.code === 'trade' ? 'Metall Asia' : 'TIZ');
  const label = companyKey === 'all' ? t('bothCompanies') : company ? short(company) : t('company');
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={[{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 38, paddingHorizontal: 14, borderRadius: 19, backgroundColor: colors.card }, neu(colors, 'raisedSm')]}>
        <Feather name="briefcase" size={14} color={colors.textSecondary} />
        <Text variant="callout" style={{ fontWeight: '600' }}>{label}</Text>
        <Feather name="chevron-down" size={14} color={colors.textMuted} />
      </Pressable>
      <Sheet visible={open} onClose={() => setOpen(false)} title={t('company')}>
        {[{ uid: 'all', label: t('bothCompanies') }, ...companies.map((c) => ({ uid: c.uid, label: pick(c, 'name') }))].map((o) => {
          const on = companyKey === o.uid;
          return (
            <Pressable
              key={o.uid}
              onPress={() => { setCompanyKey(o.uid); setOpen(false); }}
              style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderRadius: 16, backgroundColor: colors.card }, neu(colors, on ? 'inset' : 'raisedSm')]}
            >
              <Text variant="callout" style={{ color: on ? colors.brand : colors.text, fontWeight: on ? '700' : '600', flex: 1 }}>{o.label}</Text>
              {on && <Feather name="check" size={18} color={colors.brand} />}
            </Pressable>
          );
        })}
        <View style={{ height: 4 }} />
      </Sheet>
    </>
  );
}
