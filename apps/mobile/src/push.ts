import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { post } from './api/client';

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
}

/** Pede permissão e registra o token no servidor. Falhas aqui nunca atrapalham o uso do app. */
export function usePushRegistration(loggedIn: boolean) {
  useEffect(() => {
    if (!loggedIn || Platform.OS === 'web' || !Device.isDevice) return;
    (async () => {
      try {
        const cur = await Notifications.getPermissionsAsync();
        const perm = cur.granted ? cur : await Notifications.requestPermissionsAsync();
        if (!perm.granted) return;
        const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId ?? (Constants as any).easConfig?.projectId;
        const tok = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
        await post('/push-tokens', { platform: Platform.OS === 'ios' ? 'ios' : 'android', token: tok.data });
      } catch { /* sem push: o app continua funcionando */ }
    })();
  }, [loggedIn]);
}
