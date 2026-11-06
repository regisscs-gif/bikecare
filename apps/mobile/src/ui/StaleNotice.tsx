import React from 'react';
import { P } from './kit';
import { dateTimeBR } from '../util/format';
import { t } from '../i18n';

/** Se a última busca falhou mas há dados em cache, mostra quando eles foram carregados (modo somente leitura). */
export function StaleNotice({ query }: { query: { isError: boolean; data: unknown; dataUpdatedAt: number } }) {
  if (!query.isError || !query.data) return null;
  return <P muted small>{t('error.stale', { when: dateTimeBR(query.dataUpdatedAt) })}</P>;
}
