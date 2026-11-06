import React from 'react';
import { Text } from 'react-native';
import { Card, P, ProgressBar, Row, TrafficPill } from './kit';
import { colors } from '../theme';
import { t } from '../i18n';
import { distance, unitLabel } from '../util/format';
import type { PartSummary } from '../api/types';

export function nextText(p: PartSummary, unit: 'km' | 'mi'): string | null {
  if (!p.next || p.next.remaining == null) return null;
  const rem = p.next.unit === 'km' ? distance(p.next.remaining, unit) : `${Math.round(p.next.remaining)} ${unitLabel(p.next.unit ?? 'days')}`;
  return p.color === 'RED' ? `${p.next.service}: ${p.overdueLabel ?? t('color.RED')}` : `${p.next.service}: ${t('part.remaining', { n: rem.split(' ')[0]!, unit: rem.split(' ')[1] ?? '' })}`;
}

export function PartRow({ part, unit, onPress }: { part: PartSummary; unit: 'km' | 'mi'; onPress: () => void }) {
  const nt = nextText(part, unit);
  return (
    <Card onPress={onPress}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, flexShrink: 1 }}>{part.label}</Text>
        <TrafficPill color={part.color} />
      </Row>
      <P muted small>{part.positionName ?? part.category}{part.isGeneric ? ` · ${t('part.generic')}` : part.manufacturer ? ` · ${part.manufacturer}` : ''}</P>
      <ProgressBar pct={part.pct} color={part.color} />
      {nt ? <P small>{nt}</P> : null}
    </Card>
  );
}
