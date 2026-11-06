import React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { del, post } from '../../src/api/client';
import { useBike, useWrite } from '../../src/api/hooks';
import { useAuth } from '../../src/auth/AuthProvider';
import { Button, Card, Counts, ErrorBox, H1, H2, Loading, P, Row, Screen, Section, TrafficPill } from '../../src/ui/kit';
import { PartRow } from '../../src/ui/PartRow';
import { StaleNotice } from '../../src/ui/StaleNotice';
import { confirm } from '../../src/ui/dialogs';
import { t, type TKey } from '../../src/i18n';

export default function BikeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { me } = useAuth();
  const q = useBike(id);
  const act = useWrite((v: { path: string; method?: 'POST' | 'DELETE' }) => (v.method === 'DELETE' ? del(v.path) : post(v.path)));
  const unit = me?.distanceUnit ?? 'km';

  if (q.isLoading) return <Loading />;
  if (!q.data) return <Screen><ErrorBox error={q.error} onRetry={() => q.refetch()} /></Screen>;
  const { bike, parts, positions } = q.data;
  const empty = positions.filter((p) => !p.partId);
  const archived = bike.status !== 'ACTIVE';

  return (
    <Screen>
      <Stack.Screen options={{ title: bike.name }} />
      <StaleNotice query={q} />
      <Row style={{ justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}>
          <H1>{bike.name}</H1>
          <P muted small>{t(`type.${bike.type}` as TKey)}{bike.brand ? ` · ${bike.brand}` : ''}{bike.model ? ` ${bike.model}` : ''}{bike.year ? ` · ${bike.year}` : ''}</P>
        </View>
        {archived ? <P muted>{t('bike.archived')}</P> : <TrafficPill color={q.data.color} />}
      </Row>
      <Counts counts={q.data.counts} />

      {!archived ? (
        <Row>
          <View style={{ flex: 1 }}><Button small title={t('home.registerMaintenance')} onPress={() => router.push(`/maintenance/new?bikeId=${id}`)} /></View>
          <View style={{ flex: 1 }}><Button small kind="secondary" title={t('home.logRide')} onPress={() => router.push(`/ride/new?bikeId=${id}`)} /></View>
        </Row>
      ) : null}
      <Button small kind="secondary" title={t('maint.history')} onPress={() => router.push(`/maintenance/history?bikeId=${id}`)} />

      <Section title={t('bike.parts')}>
        {parts.length === 0 ? <P muted>{t('bike.noParts')}</P> : null}
        {parts.map((p) => <PartRow key={p.id} part={p} unit={unit} onPress={() => router.push(`/part/${p.id}`)} />)}
      </Section>

      {empty.length > 0 && !archived ? (
        <Section title={t('bike.positions')}>
          {empty.map((p) => (
            <Card key={p.id}>
              <Row style={{ justifyContent: 'space-between' }}>
                <P>{p.name}</P>
                <Button small kind="secondary" title={t('bike.addPart')} onPress={() => router.push(`/part/new?positionId=${p.id}&categoryId=${p.categoryId}&bikeId=${id}`)} />
              </Row>
            </Card>
          ))}
        </Section>
      ) : null}

      <Section title={bike.name}>
        {act.error ? <ErrorBox error={act.error} /> : null}
        {!archived && !bike.isDefault ? <Button kind="secondary" title={t('bike.makeDefault')} onPress={() => act.mutate({ path: `/bikes/${id}/default` })} /> : null}
        {archived ? (
          <Button kind="secondary" title={t('bike.unarchive')} onPress={() => act.mutate({ path: `/bikes/${id}/unarchive` })} />
        ) : (
          <Button kind="secondary" title={t('bike.archive')} onPress={async () => { if (await confirm(t('bike.archive'), t('bike.archiveHint'), t('bike.archive'))) act.mutate({ path: `/bikes/${id}/archive` }, { onSuccess: () => router.back() }); }} />
        )}
        <Button kind="danger" title={t('bike.delete')} onPress={async () => {
          if (await confirm(t('bike.delete'), t('bike.deleteConfirm'), t('common.delete'), true)) act.mutate({ path: `/bikes/${id}?confirm=true`, method: 'DELETE' }, { onSuccess: () => router.replace('/') });
        }} />
      </Section>
    </Screen>
  );
}
