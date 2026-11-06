import React, { useState } from 'react';
import { useRouter } from 'expo-router';
import { post } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthProvider';
import { Button, Check, ErrorBox, H1, P, Screen } from '../../src/ui/kit';
import { t } from '../../src/i18n';

export default function Terms() {
  const { me, reloadMe } = useAuth();
  const router = useRouter();
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  async function accept() {
    setBusy(true); setErr(null);
    try {
      await post('/me/terms', { version: me?.requiredTermsVersion });
      await reloadMe();
      router.replace('/onboarding/strava');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <H1>{t('terms.title')}</H1>
      <P>{t('terms.body')}</P>
      <Check label={t('terms.accept')} checked={ok} onChange={setOk} />
      {err ? <ErrorBox error={err} /> : null}
      <Button title={t('common.continue')} onPress={accept} disabled={!ok} loading={busy} />
    </Screen>
  );
}
