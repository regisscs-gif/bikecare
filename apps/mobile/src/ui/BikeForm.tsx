import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../api/client';
import { useWrite } from '../api/hooks';
import { Button, Check, ErrorBox, Field, Loading, P, Segmented } from './kit';
import { t, type TKey } from '../i18n';
import { isIsoDate, isoToday } from '../util/format';

export function BikeForm({ onCreated }: { onCreated: (id: string) => void }) {
  const types = useQuery({ queryKey: ['bike-types'], queryFn: () => get<Array<{ type: string; positions: Array<{ name: string }> }>>('/bike-types'), staleTime: Infinity });
  const [name, setName] = useState('');
  const [type, setType] = useState('MTB_FULL');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [suggested, setSuggested] = useState(true);
  const [since, setSince] = useState('');
  const [formErr, setFormErr] = useState<string | null>(null);

  const create = useWrite(async () => {
    const r = await post<{ id: string }>('/bikes', {
      name: name.trim(), type, brand: brand.trim() || null, model: model.trim() || null,
      year: year ? Number(year) : null, withSuggestedParts: suggested, partsInstalledAt: suggested && since ? since : null,
    });
    return r.id;
  });

  if (types.isLoading) return <Loading />;
  const positions = types.data?.find((x) => x.type === type)?.positions ?? [];

  function submit() {
    setFormErr(null);
    if (name.trim().length < 1) return setFormErr(t('bike.name'));
    if (year && !/^(19|20)\d{2}$/.test(year)) return setFormErr(t('bike.year'));
    if (since && !isIsoDate(since)) return setFormErr('AAAA-MM-DD');
    create.mutate(undefined, { onSuccess: (id) => onCreated(id as string) });
  }

  return (
    <>
      <Field label={t('bike.name')} value={name} onChangeText={setName} placeholder={t('bike.namePlaceholder')} />
      <P muted small>{t('bike.type')}</P>
      <Segmented value={type} onChange={setType} options={(types.data ?? []).map((x) => ({ value: x.type, label: t(`type.${x.type}` as TKey) }))} />
      <Field label={`${t('bike.brand')} (${t('common.optional')})`} value={brand} onChangeText={setBrand} />
      <Field label={`${t('bike.model')} (${t('common.optional')})`} value={model} onChangeText={setModel} />
      <Field label={`${t('bike.year')} (${t('common.optional')})`} value={year} onChangeText={setYear} keyboardType="number-pad" maxLength={4} />
      <Check label={t('bike.suggestedParts')} sub={`${t('bike.suggestedPartsHint')} ${positions.map((p) => p.name).join(', ')}`} checked={suggested} onChange={setSuggested} />
      {suggested ? (
        <Field label={`${t('bike.partsSince')} (${t('common.optional')})`} value={since} onChangeText={setSince} placeholder={isoToday()} hint="AAAA-MM-DD" autoCapitalize="none" />
      ) : null}
      {formErr ? <P style={{ color: '#C62F2F' }}>{formErr}</P> : null}
      {create.error ? <ErrorBox error={create.error} /> : null}
      <Button title={t('common.save')} onPress={submit} loading={create.isPending} />
    </>
  );
}
