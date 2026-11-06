import React from 'react';
import { View } from 'react-native';
import { post } from '../src/api/client';
import { useUpdates, useWrite } from '../src/api/hooks';
import { Button, Card, Empty, ErrorBox, H2, Loading, P, Row, Screen, TrafficPill } from '../src/ui/kit';
import { t } from '../src/i18n';

/** Reprocessamento com escolha: mostra antes/depois por peça e por serviço; nada muda até o usuário decidir. */
export default function Updates() {
  const q = useUpdates();
  const decide = useWrite((v: { id: string; decision: 'APPLIED' | 'DECLINED' | 'LATER' }) => post(`/updates/${v.id}/decision`, { decision: v.decision }));

  return (
    <Screen>
      <P muted>{t('updates.hint')}</P>
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : null}
      {q.data && q.data.length === 0 ? <Empty text={t('notif.empty')} /> : null}
      {q.data?.map((u) => (
        <Card key={u.id}>
          <H2>{u.description || t('updates.title')}</H2>
          {u.parts.map((p) => (
            <View key={p.partId} style={{ gap: 6, paddingVertical: 6 }}>
              <P style={{ fontWeight: '700' }}>{p.label}</P>
              {p.services.map((s) => (
                <Row key={s.service} style={{ flexWrap: 'wrap' }}>
                  <P small style={{ flex: 1 }}>{s.service}</P>
                  {s.before ? <TrafficPill color={s.before.color} text={`${t('updates.before')} ${s.before.pct}%`} /> : null}
                  {s.after ? <TrafficPill color={s.after.color} text={`${t('updates.after')} ${s.after.pct}%`} /> : null}
                </Row>
              ))}
            </View>
          ))}
          <Button title={t('updates.apply')} loading={decide.isPending} onPress={() => decide.mutate({ id: u.id, decision: 'APPLIED' })} />
          <Button kind="secondary" title={t('updates.keep')} onPress={() => decide.mutate({ id: u.id, decision: 'DECLINED' })} />
          {!u.mandatory ? <Button kind="ghost" title={t('updates.later')} onPress={() => decide.mutate({ id: u.id, decision: 'LATER' })} /> : null}
        </Card>
      ))}
    </Screen>
  );
}
