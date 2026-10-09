import React, { useCallback, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { Feather } from '@/ui/Icon';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Sheet } from '@/ui/Sheet';
import { Button, Card, Field, KV } from '@/ui/components';
import { Text } from '@/ui/Text';
import { Pressable } from '@/ui/Pressable';
import { api, ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { useI18n } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';

const TYPES = ['qr', 'code128', 'code39', 'ean13', 'ean8', 'upc_a', 'datamatrix', 'itf14'] as const;

/**
 * Сканер штрихкодов и QR. Код уходит в `GET /warehouse/scan` — единую точку
 * разбора: сервер сам знает, номенклатура это, партия, ячейка или серийный номер.
 */
export default function Scan() {
  const { t, pick } = useI18n();
  const { colors } = useTheme();
  const { can } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [perm, requestPerm] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [manual, setManual] = useState('');
  const [result, setResult] = useState<any | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  const resolve = useCallback(async (raw: string) => {
    const code = raw.trim();
    if (!code || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const r = await api<any>('/warehouse/scan', { query: { code } });
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setNotFound(null);
      setResult(r);
    } catch (e) {
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      setResult(null);
      setNotFound(e instanceof ApiError && e.status === 404 ? `${t('whNotFound')}: ${code}` : e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const closeResult = () => {
    setResult(null);
    setNotFound(null);
    setTimeout(() => { lock.current = false; }, 500);
  };

  const kindLabel = { item: t('whKindItem'), batch: t('whKindBatch'), location: t('whKindLocation'), serial: t('whKindSerial') } as Record<string, string>;
  const title = result ? (result.nameRu ? pick(result, 'name') : result.number ?? result.code ?? result.labelCode) : '';
  const itemCode = result?.itemCode ?? (result?.kind === 'item' ? result.code : undefined);

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {perm?.granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: [...TYPES] }}
          onBarcodeScanned={(r) => resolve(r.data)}
        />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 }}>
          <Feather name="camera-off" size={40} color="#a1a1aa" />
          <Text style={{ color: '#d4d4d8', textAlign: 'center' }}>{t('whCameraDenied')}</Text>
          {perm?.canAskAgain !== false && <Button title={t('whScan')} onPress={requestPerm} />}
        </View>
      )}

      {/* рамка прицела */}
      {perm?.granted && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <View style={{ width: 260, height: 260, borderRadius: 28, borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)' }} />
          <Text variant="callout" style={{ color: '#fff', marginTop: 20, textShadowColor: '#000', textShadowRadius: 6 }}>{t('whScanHint')}</Text>
        </View>
      )}

      <View style={{ position: 'absolute', top: insets.top + 12, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between' }}>
        <Pressable onPress={() => router.back()} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}>
          <Feather name="x" size={22} color="#fff" />
        </Pressable>
        {perm?.granted && (
          <Pressable onPress={() => setTorch((v) => !v)} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: torch ? '#fff' : 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}>
            <Feather name="zap" size={20} color={torch ? '#000' : '#fff'} />
          </Pressable>
        )}
      </View>

      {/* ручной ввод: сканер-«клавиатура» и поломанная этикетка */}
      <View style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 16, flexDirection: 'row', gap: 10, alignItems: 'flex-end' }}>
        <View style={{ flex: 1 }}>
          <Field placeholder={t('whScanManual')} value={manual} onChangeText={setManual} autoCapitalize="characters" autoCorrect={false} onSubmitEditing={() => resolve(manual)} returnKeyType="search" />
        </View>
        <Button title={t('whFind')} onPress={() => resolve(manual)} loading={busy} disabled={!manual.trim()} />
      </View>

      <Sheet visible={!!result || !!notFound} onClose={closeResult} title={result ? kindLabel[result.kind] ?? t('whScanned') : t('whNotFound')}>
        {notFound && <Text tone="danger">{notFound}</Text>}
        {result && (
          <>
            <Text variant="headline">{title}</Text>
            <Card>
              {!!result.labelCode && <KV k={t('whCode')} v={result.labelCode} />}
              {!!itemCode && <KV k={t('whItem')} v={itemCode} />}
              {!!result.unit && <KV k="Ед." v={result.unit} />}
              {!!result.warehouseCode && <KV k={t('whWarehouse')} v={result.warehouseCode} />}
              {result.kind === 'location' && <KV k={t('whLocation')} v={result.code} />}
            </Card>
            <Button
              title={t('whOpen')}
              icon="package"
              variant="secondary"
              onPress={() => {
                const q = result.kind === 'item' ? result.code : result.kind === 'batch' ? result.number : result.kind === 'location' ? result.code : result.number ?? result.code;
                closeResult();
                router.replace({ pathname: '/(tabs)/warehouse', params: { q } });
              }}
            />
            {can('warehouse.move') && result.kind !== 'location' && (
              <Button
                title={t('whNewMove')}
                icon="repeat"
                onPress={() => {
                  const params: any = { move: '1', item: itemCode };
                  if (result.kind === 'batch') params.batch = result.number;
                  closeResult();
                  router.replace({ pathname: '/(tabs)/warehouse', params });
                }}
              />
            )}
          </>
        )}
      </Sheet>
    </View>
  );
}
