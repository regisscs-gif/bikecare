import React, { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { post } from '../../src/api/client';
import { Button, ErrorBox, Loading, Screen } from '../../src/ui/kit';
import { t } from '../../src/i18n';

/** Destino do redirecionamento do Strava na web (e fallback por deep link no celular). */
export default function StravaCallback() {
  const { code, scope, error } = useLocalSearchParams<{ code?: string; scope?: string; error?: string }>();
  const router = useRouter();
  const [err, setErr] = useState<unknown>(error ? new Error(String(error)) : null);

  useEffect(() => {
    if (!code || err) return;
    post('/strava/connect', { code, scope: scope ?? '' })
      .then(() => router.replace('/onboarding/strava'))
      .catch(setErr);
  }, [code, scope, err, router]);

  return (
    <Screen>
      {err ? <><ErrorBox error={err} /><Button title={t('common.back')} onPress={() => router.replace('/account')} /></> : <Loading />}
    </Screen>
  );
}
