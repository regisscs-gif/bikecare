import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { post } from '../../src/api/client';
import { useWrite } from '../../src/api/hooks';
import { Button, Card, ErrorBox, H2, P, Row, Screen, TrafficPill } from '../../src/ui/kit';
import { ModelPicker } from '../../src/ui/ModelPicker';
import { t } from '../../src/i18n';
import type { ModelRow } from '../../src/api/types';

interface Preview { applied: boolean; changes: Array<{ service: string; before: string | null; after: string | null }>; wearBefore: { pct: number; color: any }; wearAfter: { pct: number; color: any } }

export default function ChangeModel() {
  const { partId, categoryId } = useLocalSearchParams<{ partId: string; categoryId: string }>();
  const router = useRouter();
  const [picked, setPicked] = useState<ModelRow | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const run = useWrite((v: { modelId: string | null; confirm: boolean }) => post<Preview>(`/parts/${partId}/model`, v));

  function choose(m: ModelRow) {
    setPicked(m);
    run.mutate({ modelId: m.isGeneric ? null : m.id, confirm: false }, { onSuccess: (r) => setPreview(r as Preview) });
  }

  return (
    <Screen>
      {preview && picked ? (
        <Card>
          <H2>{t('part.previewTitle')}</H2>
          {preview.changes.length === 0 ? <P>{t('part.noChanges')}</P> : preview.changes.map((c) => (
            <View key={c.service} style={{ gap: 2 }}>
              <P style={{ fontWeight: '700' }}>{c.service}</P>
              <P small muted>{c.before ?? '—'}  →  {c.after ?? '—'}</P>
            </View>
          ))}
          <Row><TrafficPill color={preview.wearBefore.color} text={`${t('updates.before')} ${preview.wearBefore.pct}%`} /><TrafficPill color={preview.wearAfter.color} text={`${t('updates.after')} ${preview.wearAfter.pct}%`} /></Row>
          {run.error ? <ErrorBox error={run.error} /> : null}
          <Button title={t('part.confirmModel')} loading={run.isPending}
            onPress={() => run.mutate({ modelId: picked.isGeneric ? null : picked.id, confirm: true }, { onSuccess: () => router.back() })} />
          <Button kind="ghost" title={t('common.cancel')} onPress={() => { setPreview(null); setPicked(null); }} />
        </Card>
      ) : (
        <ModelPicker categoryId={categoryId} onSelect={choose} />
      )}
    </Screen>
  );
}
