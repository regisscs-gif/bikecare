import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { post } from '../../src/api/client';
import { useBikes, useMaintForm, useWrite } from '../../src/api/hooks';
import { Button, Card, Check, ErrorBox, Field, H2, Loading, P, Row, Screen, Section, Segmented, TrafficPill } from '../../src/ui/kit';
import { isIsoDate, isoToday, parseMoney } from '../../src/util/format';
import { t } from '../../src/i18n';

interface PartSel { services: Set<string>; replaced: boolean; oldPart: 'RETIRE' | 'STOCK'; other: string }

function MaintForm({ bikeId }: { bikeId: string }) {
  const router = useRouter();
  const form = useMaintForm(bikeId);
  const [sel, setSel] = useState<Record<string, PartSel>>({});
  const [date, setDate] = useState(isoToday());
  const [shop, setShop] = useState('');
  const [partsCost, setPartsCost] = useState('');
  const [laborCost, setLaborCost] = useState('');
  const [notes, setNotes] = useState('');
  const [formErr, setFormErr] = useState<string | null>(null);

  // Serviços vencidos ou próximos (amarelo em diante) já vêm marcados.
  useEffect(() => {
    if (!form.data) return;
    setSel((cur) => {
      if (Object.keys(cur).length) return cur;
      return Object.fromEntries(form.data!.map((p) => [p.partId, { services: new Set(p.services.filter((s) => s.preselected).map((s) => s.serviceId)), replaced: false, oldPart: 'RETIRE' as const, other: '' }]));
    });
  }, [form.data]);

  const save = useWrite(() => {
    const items = Object.entries(sel)
      .filter(([, v]) => v.services.size > 0 || v.replaced || v.other.trim())
      .map(([partId, v]) => ({
        partId, serviceIds: [...v.services], other: v.other.trim() || null,
        replacement: v.replaced ? { oldPart: v.oldPart } : null,
      }));
    return post(`/bikes/${bikeId}/maintenance`, {
      date, shop: shop.trim() || null, notes: notes.trim() || null,
      partsCostCents: partsCost ? parseMoney(partsCost) : undefined, laborCostCents: laborCost ? parseMoney(laborCost) : undefined, items,
    });
  });

  if (form.isLoading) return <Loading />;
  if (form.error) return <ErrorBox error={form.error} onRetry={() => form.refetch()} />;

  const patchPart = (id: string, p: Partial<PartSel>) => setSel((s) => ({ ...s, [id]: { ...s[id]!, ...p } }));
  const toggleService = (id: string, sid: string, on: boolean) => {
    const next = new Set(sel[id]!.services);
    if (on) next.add(sid); else next.delete(sid);
    patchPart(id, { services: next });
  };

  function submit() {
    setFormErr(null);
    if (!isIsoDate(date)) return setFormErr('AAAA-MM-DD');
    if (partsCost && !Number.isFinite(parseMoney(partsCost))) return setFormErr(t('maint.partsCost'));
    if (laborCost && !Number.isFinite(parseMoney(laborCost))) return setFormErr(t('maint.laborCost'));
    const any = Object.values(sel).some((v) => v.services.size > 0 || v.replaced || v.other.trim());
    if (!any) return setFormErr(t('maint.minimum'));
    save.mutate(undefined, { onSuccess: () => router.back() });
  }

  return (
    <>
      <Field label={t('maint.date')} value={date} onChangeText={setDate} hint="AAAA-MM-DD" autoCapitalize="none" />
      <Section title={t('maint.parts')}>
        {form.data?.map((p) => {
          const v = sel[p.partId];
          if (!v) return null;
          return (
            <Card key={p.partId}>
              <Row style={{ justifyContent: 'space-between' }}>
                <H2>{p.label}</H2>
                <TrafficPill color={p.color} />
              </Row>
              {p.services.map((s) => (
                <Check key={s.serviceId} label={s.name} sub={`${s.pct}%`} checked={v.services.has(s.serviceId)} onChange={(on) => toggleService(p.partId, s.serviceId, on)} />
              ))}
              <Check label={t('maint.replaced')} checked={v.replaced} onChange={(on) => patchPart(p.partId, { replaced: on })} />
              {v.replaced ? (
                <View style={{ gap: 6 }}>
                  <P muted small>{t('maint.oldPartRetire')} / {t('maint.oldPartStock')}</P>
                  <Segmented value={v.oldPart} onChange={(o) => patchPart(p.partId, { oldPart: o })} options={[{ value: 'RETIRE', label: t('maint.oldPartRetire') }, { value: 'STOCK', label: t('maint.oldPartStock') }]} />
                </View>
              ) : null}
              <Field label={t('maint.other')} value={v.other} onChangeText={(x) => patchPart(p.partId, { other: x })} />
            </Card>
          );
        })}
      </Section>
      <Field label={`${t('maint.shop')} (${t('common.optional')})`} value={shop} onChangeText={setShop} />
      <Field label={`${t('maint.partsCost')} (${t('common.optional')})`} value={partsCost} onChangeText={setPartsCost} keyboardType="decimal-pad" placeholder="0,00" />
      <Field label={`${t('maint.laborCost')} (${t('common.optional')})`} value={laborCost} onChangeText={setLaborCost} keyboardType="decimal-pad" placeholder="0,00" />
      <Field label={`${t('maint.notes')} (${t('common.optional')})`} value={notes} onChangeText={setNotes} multiline />
      {formErr ? <P style={{ color: '#C62F2F' }}>{formErr}</P> : null}
      {save.error ? <ErrorBox error={save.error} /> : null}
      <Button title={t('common.save')} onPress={submit} loading={save.isPending} />
    </>
  );
}

export default function NewMaintenance() {
  const { bikeId } = useLocalSearchParams<{ bikeId?: string }>();
  const bikes = useBikes();
  const [chosen, setChosen] = useState<string>(bikeId ?? '');
  const active = (bikes.data ?? []).filter((b: any) => b.status === 'ACTIVE');
  const id = chosen || (active.length === 1 ? active[0].id : '');
  return (
    <Screen>
      {active.length > 1 ? <Segmented value={id} onChange={setChosen} options={active.map((b: any) => ({ value: b.id, label: b.name }))} /> : null}
      {id ? <MaintForm key={id} bikeId={id} /> : bikes.isLoading ? <Loading /> : null}
    </Screen>
  );
}
