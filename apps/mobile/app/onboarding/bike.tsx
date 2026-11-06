import React from 'react';
import { useRouter } from 'expo-router';
import { BikeForm } from '../../src/ui/BikeForm';
import { H1, Screen } from '../../src/ui/kit';
import { t } from '../../src/i18n';

export default function OnboardingBike() {
  const router = useRouter();
  return (
    <Screen>
      <H1>{t('bike.add')}</H1>
      <BikeForm onCreated={() => router.replace('/')} />
    </Screen>
  );
}
