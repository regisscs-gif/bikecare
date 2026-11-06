import React, { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { post } from '../../src/api/client';
import { useBikes, useWrite } from '../../src/api/hooks';
import { Button, ErrorBox, Field, Loading, P, Screen, Segmented } from '../../src/ui/kit';
import { isIsoDate, isoToday, parseMoney } from '../../src/util/format';
import { t, type TKey } from '../../src/i18n';

const CATS = ['PARTS', 'MAINTENANCE', 'LABOR', 'ACCESSORIES', 'TOOLS', 'TIRES', 'OTHER'];

export default function NewExpense() {
  const { bikeId: initial } = useLocalSearchParams<{ bikeId?: string }>();
  const router = useRouter();
  const bikes = useBikes();
  const [bikeId, setBikeId] = useState(initial ?? '');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('PARTS');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(isoToday());
  const [formErr, setFormErr] = useState<string | null>(null);
  const save = useWrite(() => post('/expenses', { bikeId: bikeId || bikes.data?.[0]?.id, amountCents: parseMoney(amount), category, description: description.trim() || null, date }));

  if (bikes.isLoading) return <Loading />;
  const active = (bikes.data ?? []).filter((b: any) => b.status === 'ACTIVE');

  function submit() {
    setFormErr(null);
    const cents = parseMoney(amount);
    if (!Number.isFinite(cents) || cents <= 0) return setFormErr(t('expense.amount'));
    if (!isIsoDate(date)) return setFormErr('AAAA-MM-DD');
    save.mutate(undefined, { onSuccess: () => router.back() });
  }

  return (
    <Screen>
      {active.length > 1 ? <Segmented value={bikeId || active[0].id} onChange={setBikeId} options={active.map((b: any) => ({ value: b.id, label: b.name }))} /> : null}
      <Field label={t('expense.amount')} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0,00" />
      <P muted small>{t('expense.category')}</P>
      <Segmented value={category} onChange={setCategory} options={CATS.map((c) => ({ value: c, label: t(`expense.${c}` as TKey) }))} />
      <Field label={`${t('expense.description')} (${t('common.optional')})`} value={description} onChangeText={setDescription} />
      <Field label={t('maint.date')} value={date} onChangeText={setDate} hint="AAAA-MM-DD" autoCapitalize="none" />
      {formErr ? <P style={{ color: '#C62F2F' }}>{formErr}</P> : null}
      {save.error ? <ErrorBox error={save.error} /> : null}
      <Button title={t('common.save')} onPress={submit} loading={save.isPending} />
    </Screen>
  );
}
