import React, { useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@/ui/Icon';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE, ApiError, headers, newKey } from '@/api/client';
import { useApi } from '@/api/query';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useOnline } from '@/lib/network';
import { useTheme } from '@/theme/ThemeProvider';
import { useToast } from '@/ui/Toast';
import { Pressable } from '@/ui/Pressable';
import { Sheet } from '@/ui/Sheet';
import { Button } from '@/ui/components';
import { Text } from '@/ui/Text';

type Owner = 'stock_move' | 'batch' | 'finance_operation' | 'production_order' | 'production_stage' | 'document' | 'partner';

/** Загрузка файла как есть, телом запроса: так принимает сервер (`POST /attachments`). */
export async function uploadAsset(owner: Owner, uid: string, asset: { uri: string; mimeType?: string | null; fileName?: string | null }, comment?: string) {
  const blob = await (await fetch(asset.uri)).blob();
  const mime = asset.mimeType || blob.type || 'image/jpeg';
  const ext = mime.split('/')[1] ?? 'jpg';
  const name = asset.fileName || `photo-${Date.now()}.${ext}`;
  const qs = `owner=${owner}&uid=${uid}&name=${encodeURIComponent(name)}${comment ? `&comment=${encodeURIComponent(comment)}` : ''}`;
  const res = await fetch(`${API_BASE}/attachments?${qs}`, { method: 'POST', headers: headers({ 'Content-Type': mime, 'Idempotency-Key': newKey() }), body: blob });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(json?.error?.code ?? 'UPLOAD', json?.error?.message ?? 'Не удалось загрузить', res.status);
  return json?.data;
}

/** Снимок с камеры, сжатый на телефоне: цех с плохой связью не должен гонять оригиналы по 8 МБ. */
export async function pickPhoto(source: 'camera' | 'library') {
  if (source === 'camera') {
    const p = await ImagePicker.requestCameraPermissionsAsync();
    if (!p.granted) return null;
    const r = await ImagePicker.launchCameraAsync({ quality: 0.6, allowsEditing: false });
    return r.canceled ? null : r.assets[0];
  }
  const r = await ImagePicker.launchImageLibraryAsync({ quality: 0.6, mediaTypes: ['images'] });
  return r.canceled ? null : r.assets[0];
}

export function PhotoStrip({ owner, uid, canEdit }: { owner: Owner; uid: string; canEdit: boolean }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const online = useOnline();
  const toast = useToast();
  const qc = useQueryClient();
  const list = useApi<any[]>('/attachments', { owner, uid });
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [view, setView] = useState<any | null>(null);

  const add = async (src: 'camera' | 'library') => {
    setMenu(false);
    if (!online) return toast.show(t('needsNetwork'), 'error');
    const a = await pickPhoto(src);
    if (!a) return;
    setBusy(true);
    try {
      await uploadAsset(owner, uid, a);
      toast.show(t('prUploaded'), 'success');
      await qc.invalidateQueries({ queryKey: ['api'] });
    } catch (e: any) {
      toast.show(e?.message ?? 'Error', 'error');
    } finally {
      setBusy(false);
    }
  };

  const src = (a: any) => ({ uri: `${API_BASE}/attachments/${a.uid}/file`, headers: headers() });
  const rows = (list.data ?? []).filter((a) => String(a.mimeType ?? '').startsWith('image/'));

  return (
    <View style={{ gap: 10 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
        {canEdit && (
          <Pressable onPress={() => setMenu(true)} style={{ width: 84, height: 84, borderRadius: 14, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center', opacity: online ? 1 : 0.4 }}>
            {busy ? <ActivityIndicator color={colors.textSecondary} /> : <Feather name="camera" size={22} color={colors.textSecondary} />}
          </Pressable>
        )}
        {rows.map((a) => (
          <Pressable key={a.uid} onPress={() => setView(a)}>
            <Image source={src(a)} style={{ width: 84, height: 84, borderRadius: 14, backgroundColor: colors.muted }} contentFit="cover" />
          </Pressable>
        ))}
      </ScrollView>
      <Sheet visible={menu} onClose={() => setMenu(false)} title={t('prAddPhoto')}>
        {Platform.OS !== 'web' && <Button title={t('prTakePhoto')} icon="camera" onPress={() => add('camera')} />}
        <Button title={t('prFromLibrary')} icon="image" variant="secondary" onPress={() => add('library')} />
      </Sheet>
      <Sheet visible={!!view} onClose={() => setView(null)} title={view?.fileName ?? ''} tall>
        {view && <Image source={src(view)} style={{ width: '100%', aspectRatio: 1, borderRadius: 16 }} contentFit="contain" />}
      </Sheet>
    </View>
  );
}
