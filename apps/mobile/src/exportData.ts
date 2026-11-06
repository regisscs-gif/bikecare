import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { get } from './api/client';

/** Exporta os dados do usuário (LGPD) como JSON: download na web, folha de compartilhamento no celular. */
export async function exportMyData(): Promise<void> {
  const data = await get('/me/export');
  const json = JSON.stringify(data, null, 2);
  const name = `bikecare-meus-dados-${new Date().toISOString().slice(0, 10)}.json`;
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
    return;
  }
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  file.write(json);
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: name });
}
