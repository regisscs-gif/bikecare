import React, { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../src/auth/AuthProvider';
import { colors } from '../src/theme';
import { t } from '../src/i18n';
import { Loading } from '../src/ui/kit';
import { usePushRegistration } from '../src/push';

// Na web o login Google abre um popup que volta para este site com o token no endereço.
// Isso precisa rodar ANTES de qualquer redirecionamento do app (que apagaria o token) para o popup avisar a janela principal e fechar.
WebBrowser.maybeCompleteAuthSession();

const queryClient = new QueryClient({
  defaultOptions: { queries: { gcTime: 1000 * 60 * 60 * 24 * 7, staleTime: 15_000, retry: 1, networkMode: 'offlineFirst' } },
});
// Cache persistido: sem internet o app mostra o último estado carregado (somente leitura).
const persister = createAsyncStoragePersister({ storage: AsyncStorage, key: 'bikecare.cache.v1', throttleTime: 1000 });

function Gate() {
  const { ready, me } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  usePushRegistration(!!me);

  useEffect(() => {
    if (!ready) return;
    const first = segments[0] as string | undefined;
    if (!me) { if (first !== 'login') router.replace('/login'); return; }
    if (!me.termsAccepted) { if (first !== 'onboarding') router.replace('/onboarding'); return; }
    if (first === 'login') router.replace('/');
  }, [ready, me, segments, router]);

  if (!ready) return <Loading />;
  return (
    <Stack screenOptions={{ headerTintColor: colors.text, headerStyle: { backgroundColor: colors.card }, contentStyle: { backgroundColor: colors.bg }, headerBackTitle: t('common.back') }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding/index" options={{ title: t('terms.title'), headerBackVisible: false }} />
      <Stack.Screen name="onboarding/strava" options={{ title: t('strava.title') }} />
      <Stack.Screen name="onboarding/bike" options={{ title: t('bike.add') }} />
      <Stack.Screen name="bike/[id]" options={{ title: '' }} />
      <Stack.Screen name="bike/new" options={{ title: t('bike.add') }} />
      <Stack.Screen name="part/[id]" options={{ title: '' }} />
      <Stack.Screen name="part/new" options={{ title: t('bike.addPart') }} />
      <Stack.Screen name="part/model" options={{ title: t('part.changeModel') }} />
      <Stack.Screen name="maintenance/new" options={{ title: t('maint.title') }} />
      <Stack.Screen name="maintenance/history" options={{ title: t('maint.history') }} />
      <Stack.Screen name="ride/new" options={{ title: t('ride.title') }} />
      <Stack.Screen name="expense/new" options={{ title: t('expense.add') }} />
      <Stack.Screen name="updates" options={{ title: t('updates.title') }} />
      <Stack.Screen name="stock" options={{ title: t('account.stock') }} />
      <Stack.Screen name="strava/callback" options={{ title: t('strava.title') }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: 1000 * 60 * 60 * 24 * 7 }}>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </PersistQueryClientProvider>
    </SafeAreaProvider>
  );
}
