import React from 'react';
import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { colors } from '../../src/theme';
import { useHome } from '../../src/api/hooks';

const icon = (e: string) => () => <Text style={{ fontSize: 20 }}>{e}</Text>;

export default function TabsLayout() {
  const home = useHome();
  const unread = home.data?.unreadCount ?? 0;
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.primary, headerStyle: { backgroundColor: colors.card }, headerTitleStyle: { fontWeight: '700' } }}>
      <Tabs.Screen name="index" options={{ title: 'Bikes', tabBarIcon: icon('🚲') }} />
      <Tabs.Screen name="expenses" options={{ title: 'Gastos', tabBarIcon: icon('💰') }} />
      <Tabs.Screen name="notifications" options={{ title: 'Avisos', tabBarIcon: icon('🔔'), tabBarBadge: unread > 0 ? unread : undefined }} />
      <Tabs.Screen name="account" options={{ title: 'Conta', tabBarIcon: icon('👤') }} />
    </Tabs>
  );
}
