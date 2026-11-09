import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, H1, P, Screen } from '../../src/ui/kit';
import { StravaGearPicker } from '../../src/ui/StravaGear';
import { StravaCard, useStravaStatus } from '../../src/ui/StravaCard';
import { t } from '../../src/i18n';

export default function OnboardingStrava() {
  const router = useRouter();
  const status = useStravaStatus();
  return (
    <Screen>
      <H1>{t('strava.title')}</H1>
      {status.data?.connected ? (
        <StravaGearPicker onDone={() => router.replace('/')} />
      ) : (
        <View style={{ gap: 12 }}>
          <P>{t('strava.body')}</P>
          <StravaCard />
          <Button title={t('common.skip')} kind="ghost" onPress={() => router.replace('/onboarding/bike')} />
        </View>
      )}
    </Screen>
  );
}
