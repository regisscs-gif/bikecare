import React, { useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../api/client';
import { Button, Card, ErrorBox, Field, P } from './kit';
import { confirm, notify } from './dialogs';
import { startStravaConnect } from '../strava';
import { dateTimeBR } from '../util/format';
import { t, type TKey } from '../i18n';

export interface StravaStatus {
  connected: boolean; status: string | null; lastSyncAt: string | null; configured: boolean;
  ownCredentials: { clientId: string } | null; sharedAvailable: boolean;
}

export const useStravaStatus = () => useQuery({ queryKey: ['strava-status'], queryFn: () => get<StravaStatus>('/strava/status') });

const callbackDomain = () => (Platform.OS === 'web' ? globalThis.location?.host ?? '' : 'o domínio do app web');

/** Cadastro das credenciais do app Strava do próprio usuário. */
function CredentialsForm({ onSaved, onCancel }: { onSaved: () => void; onCancel?: () => void }) {
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await put('/strava/credentials', { clientId: clientId.trim(), clientSecret: secret.trim() });
      setSecret('');
      onSaved();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <View style={{ gap: 10 }}>
      <P style={{ fontWeight: '700' }}>{t('strava.own.title')}</P>
      <P small muted>{t('strava.own.intro')}</P>
      <P small>{t('strava.own.step1')}</P>
      <P small>{t('strava.own.step2', { domain: callbackDomain() })}</P>
      <P small>{t('strava.own.step3')}</P>
      <Button small kind="secondary" title={t('strava.own.open')} onPress={() => Linking.openURL('https://www.strava.com/settings/api')} />
      <Field label={t('strava.own.clientId')} value={clientId} onChangeText={setClientId} keyboardType="number-pad" autoCapitalize="none" autoCorrect={false} />
      <Field label={t('strava.own.clientSecret')} value={secret} onChangeText={setSecret} secureTextEntry autoCapitalize="none" autoCorrect={false} />
      {err ? <ErrorBox error={err} /> : null}
      <Button title={t('strava.own.save')} onPress={save} loading={busy} disabled={!clientId.trim() || !secret.trim()} />
      {onCancel ? <Button kind="ghost" small title={t('strava.own.hideForm')} onPress={onCancel} /> : null}
    </View>
  );
}

/** Tudo sobre a conexão com o Strava: credenciais próprias, conectar, sincronizar e desconectar. */
export function StravaCard({ onConnected }: { onConnected?: () => void }) {
  const q = useStravaStatus();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const sc = q.data;
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['strava-status'] }); await qc.invalidateQueries({ queryKey: ['home'] }); };

  async function connect() {
    setBusy(true); setErr(null);
    try { const r = await startStravaConnect(); if (r.done) { await refresh(); onConnected?.(); } } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function disconnect() {
    if (!(await confirm(t('strava.disconnect'), t('strava.disconnectConfirm'), t('strava.disconnect'), true))) return;
    try { await del('/strava'); await refresh(); } catch (e) { setErr(e); }
  }
  async function removeCreds() {
    try { await del('/strava/credentials'); await refresh(); } catch (e) { setErr(e); }
  }

  if (!sc) return <Card><P muted>{t('common.loading')}</P></Card>;

  const needForm = !sc.connected && !sc.configured;
  return (
    <Card>
      <P>{sc.connected ? t(`strava.status.${sc.status === 'ERROR' ? 'ERROR' : 'OK'}` as TKey) : t('strava.notConnected')}</P>
      {sc.connected && sc.lastSyncAt ? <P muted small>{t('strava.lastSync', { when: dateTimeBR(sc.lastSyncAt) })}</P> : null}
      {err ? <ErrorBox error={err} /> : null}

      {sc.connected ? (
        <>
          <P muted small>{t('strava.own.sync')}</P>
          <Button kind="secondary" small title="Sincronizar agora" onPress={() => post('/strava/sync', { force: true }).then(() => { notify('Sincronização iniciada'); void refresh(); }).catch(setErr)} />
          {sc.status === 'ERROR' ? <Button small title={t('strava.connect')} onPress={connect} loading={busy} /> : null}
          <Button kind="danger" small title={t('strava.disconnect')} onPress={disconnect} />
        </>
      ) : needForm || showForm ? (
        <CredentialsForm onSaved={() => { setShowForm(false); void refresh(); }} onCancel={sc.configured ? () => setShowForm(false) : undefined} />
      ) : (
        <>
          {sc.ownCredentials ? <P small muted>{t('strava.own.saved', { id: sc.ownCredentials.clientId })}</P> : null}
          <Button title={t('strava.connect')} onPress={connect} loading={busy} />
          {sc.ownCredentials ? (
            <Button kind="ghost" small title={t('strava.own.remove')} onPress={removeCreds} />
          ) : sc.sharedAvailable ? (
            <Button kind="ghost" small title={t('strava.own.useOwn')} onPress={() => setShowForm(true)} />
          ) : null}
        </>
      )}
      <P muted small>{t('strava.powered')}</P>
    </Card>
  );
}
