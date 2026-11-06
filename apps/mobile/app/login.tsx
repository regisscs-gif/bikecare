import React, { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Google from 'expo-auth-session/providers/google';
import { useAuth } from '../src/auth/AuthProvider';
import { Button, ErrorBox, H1, P, Screen } from '../src/ui/kit';
import { t } from '../src/i18n';

WebBrowser.maybeCompleteAuthSession();

const ids = {
  web: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  ios: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  android: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
};
const configured = Platform.OS === 'web' ? !!ids.web : Platform.OS === 'ios' ? !!ids.ios : !!ids.android;

function GoogleButton() {
  const { loginWithGoogleIdToken } = useAuth();
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    webClientId: ids.web, iosClientId: ids.ios, androidClientId: ids.android,
  });

  useEffect(() => {
    if (response?.type !== 'success') { if (response?.type === 'error') setErr(response.error); return; }
    const idToken = (response.params as any)?.id_token ?? (response as any).authentication?.idToken;
    if (!idToken) { setErr(new Error(t('error.generic'))); return; }
    setBusy(true);
    loginWithGoogleIdToken(idToken).catch(setErr).finally(() => setBusy(false));
  }, [response, loginWithGoogleIdToken]);

  return (
    <View style={{ gap: 12 }}>
      <Button title={t('login.google')} onPress={() => { setErr(null); void promptAsync(); }} disabled={!request} loading={busy} />
      {err ? <ErrorBox error={err} /> : null}
    </View>
  );
}

export default function Login() {
  return (
    <Screen>
      <View style={{ gap: 12, paddingTop: 48 }}>
        <H1>{t('login.title')}</H1>
        <P muted>{t('login.subtitle')}</P>
      </View>
      {configured ? <GoogleButton /> : <P muted>{t('login.notConfigured')}</P>}
    </Screen>
  );
}
