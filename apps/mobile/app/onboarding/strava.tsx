import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../src/api/client';
import { Button, ErrorBox, H1, P, Screen } from '../../src/ui/kit';
import { StravaGearPicker } from '../../src/ui/StravaGear';
import { startStravaConnect } from '../../src/strava';
import { t } from '../../src/i18n';

export default function OnboardingStrava() {
  const router = useRouter();
  const status = useQuery({ queryKey: ['strava-status'], queryFn: () => get<{ connected: boolean; configured: boolean }>('/strava/status') });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const finish = () => router.replace('/onboarding/bike');

  async function connect() {
    setBusy(true); setErr(null);
    try { await startStravaConnect(); await status.refetch(); } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <H1>{t('strava.title')}</H1>
      {status.data?.connected ? (
        <StravaGearPicker onDone={() => router.replace('/')} />
      ) : (
        <View style={{ gap: 12 }}>
          <P>{t('strava.body')}</P>
          {status.data && !status.data.configured ? <P muted>{t('strava.notConfigured')}</P> : null}
          {err ? <ErrorBox error={err} /> : null}
          <Button title={t('strava.connect')} onPress={connect} loading={busy} disabled={status.data ? !status.data.configured : false} />
          <P muted small>{t('strava.powered')}</P>
          <Button title={t('common.skip')} kind="ghost" onPress={finish} />
        </View>
      )}
    </Screen>
  );
}
