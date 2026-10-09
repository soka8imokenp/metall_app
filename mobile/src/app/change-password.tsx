import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/ThemeProvider';
import { useI18n } from '@/i18n';
import { useAuth } from '@/auth/AuthProvider';
import { ApiError } from '@/api/client';
import { Button, Field } from '@/ui/components';
import { Text } from '@/ui/Text';

export default function ChangePassword() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const { changePassword, signOut } = useAuth();
  const insets = useSafeAreaInsets();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await changePassword(cur, next);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('loginFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.canvas, paddingTop: insets.top }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24, gap: 18 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 6 }}>
          <Text variant="largeTitle">{t('changePasswordTitle')}</Text>
          <Text tone="secondary">{t('changePasswordHint')}</Text>
        </View>
        <Field label={t('currentPassword')} value={cur} onChangeText={setCur} secureTextEntry autoCapitalize="none" />
        <Field label={t('newPassword')} value={next} onChangeText={setNext} secureTextEntry autoCapitalize="none" error={error} />
        <Button title={t('save')} onPress={submit} loading={busy} disabled={!cur || !next} needsNetwork />
        <Button title={t('signOut')} variant="ghost" onPress={signOut} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
