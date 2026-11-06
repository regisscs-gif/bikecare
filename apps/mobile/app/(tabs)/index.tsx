import React from 'react';
import { RefreshControl, ScrollView, View, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useHome } from '../../src/api/hooks';
import { useAuth } from '../../src/auth/AuthProvider';
import { Button, Card, Counts, Empty, ErrorBox, H1, Loading, P, Row, Screen, TrafficPill } from '../../src/ui/kit';
import { StaleNotice } from '../../src/ui/StaleNotice';
import { colors, space } from '../../src/theme';
import { t, type TKey } from '../../src/i18n';

export default function Home() {
  const router = useRouter();
  const { me } = useAuth();
  const q = useHome();
  const data = q.data;

  return (
    <Screen scroll={false} pad={false}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, maxWidth: 720, width: '100%', alignSelf: 'center' }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={async () => { await q.refetch(); }} />}>
        <H1>{t('home.title')}</H1>
        <StaleNotice query={q} />
        {q.isLoading ? <Loading /> : null}
        {q.error && !data ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : null}

        {data?.strava?.status === 'ERROR' ? (
          <Card onPress={() => router.push('/account')} style={{ borderColor: colors.ORANGE }}>
            <P>{t('strava.status.ERROR')}</P>
          </Card>
        ) : null}
        {data && data.pendingUpdates > 0 ? (
          <Card onPress={() => router.push('/updates')} style={{ borderColor: colors.primary }}>
            <P>{t('home.updates', { n: data.pendingUpdates })}</P>
          </Card>
        ) : null}

        {data && data.bikes.length === 0 ? (
          <>
            <Empty text={t('bike.empty')} />
            <Button title={t('bike.add')} onPress={() => router.push('/bike/new')} />
          </>
        ) : null}

        {data?.bikes.map((b) => (
          <Card key={b.id} onPress={() => router.push(`/bike/${b.id}`)}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, flexShrink: 1 }}>{b.name}{b.isDefault ? ' ★' : ''}</Text>
              <TrafficPill color={b.color} />
            </Row>
            <P muted small>{t(`type.${b.type}` as TKey)}</P>
            <Counts counts={b.counts} />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
              <View style={{ flex: 1 }}><Button small kind="secondary" title={t('home.registerMaintenance')} onPress={() => router.push(`/maintenance/new?bikeId=${b.id}`)} /></View>
              <View style={{ flex: 1 }}><Button small kind="secondary" title={t('home.logRide')} onPress={() => router.push(`/ride/new?bikeId=${b.id}`)} /></View>
            </View>
          </Card>
        ))}
        {data && data.bikes.length > 0 ? <Button kind="ghost" title={`+ ${t('bike.add')}`} onPress={() => router.push('/bike/new')} /> : null}
        {me ? null : null}
      </ScrollView>
    </Screen>
  );
}
