import React, { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../../src/api/client';
import { useWrite } from '../../src/api/hooks';
import { useAuth } from '../../src/auth/AuthProvider';
import { Button, Card, ErrorBox, Field, H2, P, Screen, Section, Toggle } from '../../src/ui/kit';
import { ModelPicker } from '../../src/ui/ModelPicker';
import { isIsoDate, isoToday, toKm } from '../../src/util/format';
import { t } from '../../src/i18n';
import type { ModelRow } from '../../src/api/types';

/** Instalar peça numa posição vazia (ou criar peça avulsa para o estoque quando não há posição). */
export default function NewPart() {
  const { positionId, categoryId: catParam } = useLocalSearchParams<{ positionId?: string; categoryId?: string; bikeId?: string }>();
  const { me } = useAuth();
  const router = useRouter();
  const unit = me?.distanceUnit ?? 'km';
  const cats = useQuery({ queryKey: ['library-categories'], queryFn: () => get<Array<{ id: string; name: string; wearsIndoorApplicable: boolean; wearsIndoorDefault: boolean; services: Array<{ id: string; name: string }> }>>('/library/categories'), staleTime: Infinity });
  const [categoryId, setCategoryId] = useState(catParam ?? '');
  const [model, setModel] = useState<ModelRow | null>(null);
  const [nickname, setNickname] = useState('');
  const [installedAt, setInstalledAt] = useState(isoToday());
  const [km, setKm] = useState('');
  const [hours, setHours] = useState('');
  const [last, setLast] = useState<Record<string, string>>({});
  const [indoor, setIndoor] = useState<boolean | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);

  const cat = cats.data?.find((c) => c.id === categoryId);
  const save = useWrite(() => post('/parts', {
    categoryId, positionId: positionId ?? null, modelId: model && !model.isGeneric ? model.id : null, nickname: nickname.trim() || null,
    installedAt, initialKm: km ? toKm(Number(km.replace(',', '.')), unit) : undefined, initialHours: hours ? Number(hours.replace(',', '.')) : undefined,
    wearsIndoor: indoor ?? cat?.wearsIndoorDefault ?? false,
    lastMaintenance: Object.fromEntries(Object.entries(last).filter(([, v]) => v.trim())),
  }));

  function submit() {
    setFormErr(null);
    if (!categoryId) return setFormErr(t('expense.category'));
    if (!isIsoDate(installedAt)) return setFormErr('AAAA-MM-DD');
    for (const v of Object.values(last)) if (v.trim() && !isIsoDate(v.trim())) return setFormErr('AAAA-MM-DD');
    save.mutate(undefined, { onSuccess: () => router.back() });
  }

  return (
    <Screen>
      {!catParam && cats.data ? (
        <Section title={t('expense.category')}>
          {cats.data.map((c) => <Button key={c.id} kind={c.id === categoryId ? 'primary' : 'secondary'} small title={c.name} onPress={() => { setCategoryId(c.id); setModel(null); }} />)}
        </Section>
      ) : cat ? <H2>{cat.name}</H2> : null}

      {categoryId ? (
        <>
          <ModelPicker categoryId={categoryId} selectedId={model?.id} onSelect={setModel} />
          <Field label={`${t('part.nickname')} (${t('common.optional')})`} value={nickname} onChangeText={setNickname} />
          <Field label="Instalada em" value={installedAt} onChangeText={setInstalledAt} hint="AAAA-MM-DD" autoCapitalize="none" />
          <P muted small>{t('part.usedHint')}</P>
          <Field label={`${t('part.initialKm').replace('km', unit)}`} value={km} onChangeText={setKm} keyboardType="decimal-pad" />
          <Field label={t('part.initialHours')} value={hours} onChangeText={setHours} keyboardType="decimal-pad" />
          {cat?.wearsIndoorApplicable ? <Toggle label={t('part.wearsIndoor')} hint={t('part.wearsIndoorHint')} value={indoor ?? cat.wearsIndoorDefault} onChange={setIndoor} /> : null}
          {cat && cat.services.length ? (
            <Card>
              <H2>Última manutenção (opcional)</H2>
              {cat.services.map((s) => (
                <Field key={s.id} label={s.name} value={last[s.id] ?? ''} onChangeText={(v) => setLast((p) => ({ ...p, [s.id]: v }))} placeholder="AAAA-MM-DD" autoCapitalize="none" />
              ))}
            </Card>
          ) : null}
          {formErr ? <P style={{ color: '#C62F2F' }}>{formErr}</P> : null}
          {save.error ? <ErrorBox error={save.error} /> : null}
          <Button title={t('common.save')} onPress={submit} loading={save.isPending} />
        </>
      ) : null}
    </Screen>
  );
}
