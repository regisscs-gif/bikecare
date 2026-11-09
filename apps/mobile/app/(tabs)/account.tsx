import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { del, patch } from '../../src/api/client';
import { useWrite } from '../../src/api/hooks';
import { useAuth } from '../../src/auth/AuthProvider';
import { Button, Card, ErrorBox, Field, H2, P, Screen, Section, Segmented, Toggle } from '../../src/ui/kit';
import { confirm, notify } from '../../src/ui/dialogs';
import { StravaCard } from '../../src/ui/StravaCard';
import { exportMyData } from '../../src/exportData';
import { t } from '../../src/i18n';

export default function Account() {
  const { me, reloadMe, logout } = useAuth();
  const router = useRouter();

  const [y, setY] = useState(''); const [o, setO] = useState(''); const [r, setR] = useState('');
  const [thErr, setThErr] = useState<string | null>(null);
  useEffect(() => {
    if (me) { setY(String(me.thresholds.yellow)); setO(String(me.thresholds.orange)); setR(String(me.thresholds.red)); }
  }, [me]);

  const savePrefs = useWrite((body: any) => patch('/me', body));
  const saveThresholds = useWrite(() => patch('/me', { thresholds: { yellow: Number(y), orange: Number(o), red: Number(r) } }));
  if (!me) return null;
  const apply = (body: any) => savePrefs.mutate(body, { onSuccess: () => { void reloadMe(); } });

  function submitThresholds() {
    setThErr(null);
    const [a, b, c] = [Number(y), Number(o), Number(r)];
    if (![a, b, c].every(Number.isFinite) || !(a < b && b < c)) return setThErr('Amarelo < laranja < vermelho (ex.: 70 / 85 / 100).');
    saveThresholds.mutate(undefined, { onSuccess: () => { void reloadMe(); } });
  }

  return (
    <Screen>
      <Card>
        <H2>{me.name}</H2>
        <P muted>{me.email}</P>
      </Card>

      <Section title="Strava">
        <StravaCard onConnected={() => router.push('/onboarding/strava')} />
      </Section>

      <Section title={t('account.preferences')}>
        <Card>
          <P muted small>{t('account.unit')}</P>
          <Segmented value={me.distanceUnit} onChange={(v) => apply({ distanceUnit: v })} options={[{ value: 'km', label: 'km' }, { value: 'mi', label: 'milhas' }]} />
        </Card>
      </Section>

      <Section title={t('account.thresholds')}>
        <Card>
          <P muted small>{t('account.thresholdsHint')}</P>
          <Field label={t('account.yellow')} value={y} onChangeText={setY} keyboardType="number-pad" />
          <Field label={t('account.orange')} value={o} onChangeText={setO} keyboardType="number-pad" />
          <Field label={t('account.red')} value={r} onChangeText={setR} keyboardType="number-pad" />
          <P muted small>{t('red.disclaimer')}</P>
          {thErr ? <P style={{ color: '#C62F2F' }}>{thErr}</P> : null}
          {saveThresholds.error ? <ErrorBox error={saveThresholds.error} /> : null}
          <Button title={t('common.save')} onPress={submitThresholds} loading={saveThresholds.isPending} />
          <Button kind="ghost" small title="Voltar ao padrão (70 / 85 / 100)" onPress={() => { setY('70'); setO('85'); setR('100'); }} />
        </Card>
      </Section>

      <Section title={t('account.notifications')}>
        <Card>
          <Toggle label={t('account.notifyWear')} value={me.notifications.wear} onChange={(v) => apply({ notifications: { wear: v } })} />
          <Toggle label={t('account.notifyRedWeekly')} value={me.notifications.redWeekly} onChange={(v) => apply({ notifications: { redWeekly: v } })} />
          <Toggle label={t('account.notifyStrava')} value={me.notifications.strava} onChange={(v) => apply({ notifications: { strava: v } })} />
        </Card>
      </Section>

      <Section title={t('account.title')}>
        <Button kind="secondary" title={t('account.stock')} onPress={() => router.push('/stock')} />
        <Button kind="secondary" title={t('account.export')} onPress={() => exportMyData().then(() => undefined).catch((e) => notify(t('error.generic'), e?.message))} />
        <Button kind="secondary" title={t('account.logout')} onPress={logout} />
        <View style={{ height: 8 }} />
        <Button kind="danger" title={t('account.delete')} onPress={async () => {
          if (await confirm(t('account.delete'), t('account.deleteConfirm'), t('common.delete'), true)) { await del('/me'); await logout(); }
        }} />
      </Section>
    </Screen>
  );
}
