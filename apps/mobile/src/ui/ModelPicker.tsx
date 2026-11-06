import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../api/client';
import { Button, Card, ErrorBox, Field, Loading, P, Row } from './kit';
import { t } from '../i18n';
import type { ModelRow } from '../api/types';

/** Busca na biblioteca por categoria. O genérico da categoria sempre vem primeiro. Se não achar, o usuário pode sugerir o modelo. */
export function ModelPicker({ categoryId, selectedId, onSelect }: { categoryId: string; selectedId?: string | null; onSelect: (m: ModelRow) => void }) {
  const [text, setText] = useState('');
  const q = useQuery({
    queryKey: ['models', categoryId, text],
    queryFn: () => get<ModelRow[]>(`/library/models?categoryId=${encodeURIComponent(categoryId)}${text.trim() ? `&q=${encodeURIComponent(text.trim())}` : ''}`),
    placeholderData: (prev) => prev,
  });
  const [sent, setSent] = useState(false);
  const [maker, setMaker] = useState('');
  const suggest = async () => {
    await post('/library/suggestions', { categoryId, manufacturer: maker.trim() || '—', name: text.trim() });
    setSent(true);
  };

  return (
    <>
      <Field label={t('part.model')} value={text} onChangeText={setText} placeholder="Ex.: GX Eagle, Deore, Maxxis…" autoCapitalize="none" />
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorBox error={q.error} /> : null}
      {q.data?.map((m) => (
        <Card key={m.id} onPress={() => onSelect(m)} style={m.id === selectedId ? { borderColor: '#1F6FEB', borderWidth: 2 } : undefined}>
          <Row style={{ justifyContent: 'space-between' }}>
            <P style={{ fontWeight: '700', flexShrink: 1 }}>{m.isGeneric ? t('part.generic') : m.name}</P>
            <P muted small>{m.manufacturer ?? ''}</P>
          </Row>
        </Card>
      ))}
      {q.data && text.trim().length > 1 && !q.data.some((m) => !m.isGeneric) ? (
        sent ? <P>{t('part.suggestSent')}</P> : (
          <Card>
            <P>{t('part.suggestModel')}</P>
            <Field label={t('bike.brand')} value={maker} onChangeText={setMaker} />
            <Button small kind="secondary" title={`${t('part.suggestModel').split('?')[1]?.trim() || 'Sugerir'}: ${text.trim()}`} onPress={suggest} />
          </Card>
        )
      ) : null}
    </>
  );
}
