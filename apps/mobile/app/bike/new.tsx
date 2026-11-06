import React from 'react';
import { useRouter } from 'expo-router';
import { BikeForm } from '../../src/ui/BikeForm';
import { Screen } from '../../src/ui/kit';

export default function NewBike() {
  const router = useRouter();
  return (
    <Screen>
      <BikeForm onCreated={(id) => router.replace(`/bike/${id}`)} />
    </Screen>
  );
}
