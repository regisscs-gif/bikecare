import React, { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { post } from '../../src/api/client';
import { useBikes, useWrite } from '../../src/api/hooks';
import { useAuth } from '../../src/auth/AuthProvider';
import { Button, Card, ErrorBox, Field, H2, Loading, P, Screen, Section, Segmented, Toggle } from '../../src/ui/kit';
import { isIsoDate, isoToday, parseNum, toKm } from '../../src/util/format';
import { ApiError } from '../../src/api/client';
import { t } from '../../src/i18n';

export default function NewRide() {
  const { bikeId: initial } = useLocalSearchParams<{ bikeId?: string }>();
  const router = useRouter();
  const { me } = useAuth();
  const unit = me?.distanceUnit ?? 'km';
  const bikes = useBikes();
  const [bikeId, setBikeId] = useState(initial ?? '');
  const [date, setDate] = useState(isoToday());
  const [dist, setDist] = useState('');
  const [mins, setMins] = useState('');
  const [indoor, setIndoor] = useState(false);
  const [dup, setDup] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [adjKm, setAdjKm] = useState('');
  const [adjH, setAdjH] = useState('');

  const active = (bikes.data ?? []).filter((b: any) => b.status === 'ACTIVE');
  const id = bikeId || active[0]?.id;

  const ride = useWrite((confirm: boolean) => post(`/bikes/${id}/rides`, {
    date, indoor, confirm,
    distanceKm: dist && !indoor ? toKm(parseNum(dist), unit) : undefined,
    movingMinutes: mins ? parseNum(mins) : undefined,
  }));
  const adjust = useWrite(() => post(`/bikes/${id}/usage-adjustments`, {
    km: adjKm ? toKm(parseNum(adjKm), unit) : undefined, hours: adjH ? parseNum(adjH) : undefined,
  }));

  if (bikes.isLoading) return <Loading />;

  function submit(confirm = false) {
    setFormErr(null);
    if (!isIsoDate(date)) return setFormErr('AAAA-MM-DD');
    const d = dist && !indoor ? parseNum(dist) : 0;
    const m = mins ? parseNum(mins) : 0;
    if (!(d > 0) && !(m > 0)) return setFormErr(t('ride.needOne'));
    ride.mutate(confirm, {
      onSuccess: () => router.back(),
      onError: (e) => { if (e instanceof ApiError && e.code === 'POSSIBLE_DUPLICATE') setDup(true); },
    });
  }

  return (
    <Screen>
      {active.length > 1 ? <Segmented value={id ?? ''} onChange={setBikeId} options={active.map((b: any) => ({ value: b.id, label: b.name }))} /> : null}
      <Field label={t('maint.date')} value={date} onChangeText={(v) => { setDate(v); setDup(false); }} hint="AAAA-MM-DD" autoCapitalize="none" />
      <Toggle label={t('ride.indoor')} hint={t('ride.indoorHint')} value={indoor} onChange={setIndoor} />
      {!indoor ? <Field label={`${t('ride.distance').replace('km', unit)}`} value={dist} onChangeText={setDist} keyboardType="decimal-pad" /> : null}
      <Field label={t('ride.minutes')} value={mins} onChangeText={setMins} keyboardType="decimal-pad" />
      {formErr ? <P style={{ color: '#C62F2F' }}>{formErr}</P> : null}
      {dup ? (
        <Card style={{ borderColor: '#EE7C1A' }}>
          <P>{t('ride.duplicate')}</P>
          <Button kind="secondary" title={t('ride.duplicateYes')} onPress={() => submit(true)} loading={ride.isPending} />
          <Button kind="ghost" title={t('common.cancel')} onPress={() => router.back()} />
        </Card>
      ) : (
        <>
          {ride.error && !dup ? <ErrorBox error={ride.error} /> : null}
          <Button title={t('common.save')} onPress={() => submit(false)} loading={ride.isPending} />
        </>
      )}

      <Section title={t('ride.adjust')}>
        <Card>
          <P muted small>{t('ride.adjustHint')}</P>
          <Field label={t('ride.adjustKm').replace('Km', unit)} value={adjKm} onChangeText={setAdjKm} keyboardType="decimal-pad" />
          <Field label={t('ride.adjustHours')} value={adjH} onChangeText={setAdjH} keyboardType="decimal-pad" />
          {adjust.error ? <ErrorBox error={adjust.error} /> : null}
          <Button kind="secondary" title={t('common.save')} disabled={!adjKm && !adjH} loading={adjust.isPending} onPress={() => adjust.mutate(undefined, { onSuccess: () => router.back() })} />
        </Card>
      </Section>
    </Screen>
  );
}
