import React from 'react';
import { View, RefreshControl, ActivityIndicator } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';
import { Pressable } from './Pressable';
import { BigTitle, EmptyState, ErrorState, OfflineBanner, ScreenTop, ContentSheet, SkeletonList, TAB_BAR_SPACE } from './components';
import { Metric } from './Band';
import { Appear } from './motion';
import { Feather } from '@/ui/Icon';

/** Экран-список на FlashList: шапка и фильтры едут вместе со списком, как в нативных приложениях. */
export function ListScreen<T>({
  title,
  subtitle,
  right,
  header,
  data,
  renderItem,
  keyExtractor,
  loading,
  error,
  onRetry,
  onRefresh,
  refreshing,
  emptyTitle,
  emptyIcon,
  onEndReached,
  loadingMore,
  back,
  padBottom = true,
  metrics,
  animKey,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  header?: React.ReactNode;
  data: T[] | undefined;
  renderItem: (item: T, index: number) => React.ReactElement;
  keyExtractor: (item: T) => string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  emptyTitle: string;
  emptyIcon?: keyof typeof Feather.glyphMap;
  onEndReached?: () => void;
  loadingMore?: boolean;
  back?: () => void;
  padBottom?: boolean;
  metrics?: Metric[];
  /** смена значения (вкладка, фильтр) — карточки собираются заново */
  animKey?: string;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const head = (
    <View style={{ paddingTop: 22 }}>
      <OfflineBanner />
      {back ? <BigTitle title={title} subtitle={subtitle} /> : null}
      {header}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ScreenTop title={title} right={right} back={back} metrics={metrics} />
      <ContentSheet animKey={animKey}>
        <FlashList
          data={data ?? []}
          keyExtractor={keyExtractor}
          renderItem={({ item, index }) => <Appear i={index} style={{ paddingHorizontal: 20, paddingBottom: 16 }}>{renderItem(item, index)}</Appear>}
          ListHeaderComponent={head}
          ListEmptyComponent={
            loading ? (
              <View style={{ paddingHorizontal: 20 }}><SkeletonList rows={6} /></View>
            ) : error ? (
              <ErrorState message={error} onRetry={onRetry} />
            ) : (
              <EmptyState icon={emptyIcon} title={emptyTitle} />
            )
          }
          ListFooterComponent={loadingMore ? <ActivityIndicator style={{ margin: 16 }} color={colors.textMuted} /> : null}
          contentContainerStyle={{ paddingBottom: padBottom ? TAB_BAR_SPACE + insets.bottom : 24 + insets.bottom }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onEndReached={onEndReached}
          onEndReachedThreshold={0.6}
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} colors={[colors.brand]} /> : undefined}
        />
      </ContentSheet>
    </View>
  );
}
