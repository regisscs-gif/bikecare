import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { get, post } from './api/client';

export const stravaRedirectUri = () => Linking.createURL('strava/callback');

/** Abre a autorização do Strava. Na web redireciona a página; no celular usa a aba de autenticação e volta com o code. */
export async function startStravaConnect(): Promise<{ done: boolean }> {
  const redirectUri = stravaRedirectUri();
  const { url, webUrl } = await get<{ url: string; webUrl: string }>(`/strava/auth-url?redirectUri=${encodeURIComponent(redirectUri)}`);
  if (Platform.OS === 'web') {
    globalThis.location.href = webUrl;
    return { done: false };
  }
  const res = await WebBrowser.openAuthSessionAsync(url, redirectUri);
  if (res.type !== 'success') return { done: false };
  const parsed = Linking.parse(res.url);
  const code = String(parsed.queryParams?.code ?? '');
  const scope = String(parsed.queryParams?.scope ?? '');
  if (!code) return { done: false };
  await post('/strava/connect', { code, scope });
  return { done: true };
}
