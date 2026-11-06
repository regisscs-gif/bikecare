import React, { useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { del, patch, post, put } from '../../src/api/client';
import { useBike, useBikes, usePart, useWrite } from '../../src/api/hooks';
import { useAuth } from '../../src/auth/AuthProvider';
import { Button, Card, ErrorBox, Field, H2, Loading, P, ProgressBar, Row, Screen, Section, Toggle, TrafficPill } from '../../src/ui/kit';
import { StaleNotice } from '../../src/ui/StaleNotice';
import { confirm } from '../../src/ui/dialogs';
import { colors } from '../../src/theme';
import { dateBR, distance, fromKm, toKm, unitLabel } from '../../src/util/format';
import { t, type TKey } from '../../src/i18n';
import type { RuleView } from '../../src/api/types';

function RuleCard({ partId, rule, unit }: { partId: string; rule: RuleView; unit: 'km' | 'mi' }) {
  const [editing, setEditing] = useState(false);
  const cur = (u: string) => rule.criteria.find((c) => c.unit === u)?.limit;
  const [km, setKm] = useState(cur('km') != null ? String(Math.round(fromKm(cur('km')!, unit))) : '');
  const [hours, setHours] = useState(cur('hours') != null ? String(cur('hours')) : '');
  const [days, setDays] = useState(cur('days') != null ? String(cur('days')) : '');
  const [err, setErr] = useState<string | null>(null);
  const save = useWrite((criteria: any) => put(`/parts/${partId}/rules/${rule.serviceId}`, { criteria }));
  const toggle = useWrite(() => put(`/parts/${partId}/rules/${rule.serviceId}`, { disabled: true }));
  const restore = useWrite(() => del(`/parts/${partId}/rules/${rule.serviceId}`));

  function submit() {
    const c: Record<string, number> = {};
    for (const [k, v] of [['km', km], ['hours', hours], ['days', days]] as const) {
      if (!v.trim()) continue;
      const n = Number(v.replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0) return setErr('Use números maiores que zero.');
      c[k] = k === 'km' ? toKm(n, unit) : n;
    }
    if (!Object.keys(c).length) return setErr('Informe ao menos um limite.');
    setErr(null);
    save.mutate(c, { onSuccess: () => setEditing(false) });
  }

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text, flexShrink: 1 }}>{rule.service}</Text>
        <TrafficPill color={rule.color} />
      </Row>
      <ProgressBar pct={rule.pct} color={rule.color} />
      {rule.criteria.map((c) => (
        <P key={c.unit} small>
          {t('part.used', {
            used: c.unit === 'km' ? distance(c.used, unit).split(' ')[0]! : String(Math.round(c.used)),
            limit: c.unit === 'km' ? distance(c.limit, unit).split(' ')[0]! : String(Math.round(c.limit)),
            unit: c.unit === 'km' ? unit : unitLabel(c.unit),
          })}
        </P>
      ))}
      {rule.color === 'RED' && rule.overdueLabel ? <P small style={{ fontWeight: '700' }}>{rule.overdueLabel}</P> : null}
      {rule.forecastDate && rule.color !== 'RED' ? <P small muted>{t('part.forecast', { date: dateBR(rule.forecastDate) })}</P> : null}
      <P small muted>{rule.originLabel}{rule.note ? ` · ${rule.note}` : ''}</P>
      {rule.sources.map((s) => (
        <Pressable key={s.id} disabled={!s.url} onPress={() => s.url && Linking.openURL(s.url)} accessibilityRole={s.url ? 'link' : 'text'}>
          <P small style={{ color: s.url ? colors.primary : colors.muted }}>{t('part.source')}: {s.title}</P>
        </Pressable>
      ))}
      {editing ? (
        <View style={{ gap: 8 }}>
          <Field label={`${t('part.adjustRule')} (${unit})`} value={km} onChangeText={setKm} keyboardType="decimal-pad" />
          <Field label="Horas" value={hours} onChangeText={setHours} keyboardType="decimal-pad" />
          <Field label="Dias" value={days} onChangeText={setDays} keyboardType="number-pad" />
          {err ? <P style={{ color: colors.danger }}>{err}</P> : null}
          {save.error ? <ErrorBox error={save.error} /> : null}
          <Row><View style={{ flex: 1 }}><Button small title={t('common.save')} onPress={submit} loading={save.isPending} /></View>
            <View style={{ flex: 1 }}><Button small kind="secondary" title={t('common.cancel')} onPress={() => setEditing(false)} /></View></Row>
        </View>
      ) : (
        <Row style={{ flexWrap: 'wrap' }}>
          <Button small kind="secondary" title={t('part.adjustRule')} onPress={() => setEditing(true)} />
          <Button small kind="ghost" title={t('part.disableRule')} onPress={() => toggle.mutate()} />
          <Button small kind="ghost" title={t('part.restoreRule')} onPress={() => restore.mutate()} />
        </Row>
      )}
    </Card>
  );
}

export default function PartScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { me } = useAuth();
  const q = usePart(id);
  const bike = useBike(q.data?.installedOn?.bikeId ?? '');
  const unit = me?.distanceUnit ?? 'km';
  const [nick, setNick] = useState<string | null>(null);
  const [ruleName, setRuleName] = useState('');
  const [ruleKm, setRuleKm] = useState('');
  const [ruleDays, setRuleDays] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [targetBike, setTargetBike] = useState('');
  const bikes = useBikes();
  const target = useBike(targetBike);
  const upd = useWrite((b: any) => patch(`/parts/${id}`, b));
  const act = useWrite((path: string) => post(`/parts/${id}/${path}`));
  const move = useWrite((positionId: string) => post(`/parts/${id}/move`, { positionId }));
  const addRule = useWrite(() => {
    const criteria: Record<string, number> = {};
    if (ruleKm) criteria.km = toKm(Number(ruleKm.replace(',', '.')), unit);
    if (ruleDays) criteria.days = Number(ruleDays);
    return post(`/parts/${id}/rules`, { name: ruleName.trim(), criteria });
  });

  if (q.isLoading) return <Loading />;
  if (!q.data) return <Screen><ErrorBox error={q.error} onRetry={() => q.refetch()} /></Screen>;
  const p = q.data;
  const targetFree = (target.data?.positions ?? []).filter((x) => !x.partId && x.categoryId === p.categoryId);
  const freePositions = (bike.data?.positions ?? []).filter((x) => !x.partId && x.categoryId === p.categoryId);

  return (
    <Screen>
      <Stack.Screen options={{ title: p.label }} />
      <StaleNotice query={q} />
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <H2>{p.label}</H2>
          <TrafficPill color={p.color} />
        </Row>
        <P muted small>{p.category}{p.isGeneric ? ` · ${t('part.generic')}` : p.manufacturer ? ` · ${p.manufacturer}` : ''}</P>
        <ProgressBar pct={p.pct} color={p.color} />
        <Field label={t('part.nickname')} value={nick ?? p.nickname ?? ''} onChangeText={setNick} onEndEditing={() => nick !== null && upd.mutate({ nickname: nick.trim() || null })} />
        <Toggle label={t('part.wearsIndoor')} hint={t('part.wearsIndoorHint')} value={p.wearsIndoor} onChange={(v) => upd.mutate({ wearsIndoor: v })} />
        <Button kind="secondary" small title={t('part.changeModel')} onPress={() => router.push(`/part/model?partId=${id}&categoryId=${p.categoryId}`)} />
      </Card>

      <Section title={t('part.rules')}>
        <P muted small>{t('red.disclaimer')}</P>
        {p.rules.length === 0 ? <P muted>{t('part.noRules')}</P> : null}
        {p.rules.map((r) => <RuleCard key={r.serviceId} partId={id} rule={r} unit={unit} />)}
        {showNew ? (
          <Card>
            <Field label={t('part.ruleName')} value={ruleName} onChangeText={setRuleName} />
            <Field label={`Limite (${unit})`} value={ruleKm} onChangeText={setRuleKm} keyboardType="decimal-pad" />
            <Field label="Limite (dias)" value={ruleDays} onChangeText={setRuleDays} keyboardType="number-pad" />
            {addRule.error ? <ErrorBox error={addRule.error} /> : null}
            <Button small title={t('common.save')} loading={addRule.isPending} disabled={ruleName.trim().length < 2 || (!ruleKm && !ruleDays)} onPress={() => addRule.mutate(undefined, { onSuccess: () => { setShowNew(false); setRuleName(''); setRuleKm(''); setRuleDays(''); } })} />
          </Card>
        ) : <Button kind="ghost" title={t('part.addRule')} onPress={() => setShowNew(true)} />}
      </Section>

      <Section title={t('part.history')}>
        {p.history.map((h) => (
          <P key={h.id} small>{dateBR(h.at)} · {t(`history.${h.type}` as TKey)}</P>
        ))}
      </Section>

      {act.error || move.error ? <ErrorBox error={act.error ?? move.error} /> : null}
      {p.status === 'INSTALLED' && freePositions.length > 0 ? (
        <>
          <Button kind="secondary" title={t('part.move')} onPress={() => setMoveOpen(!moveOpen)} />
          {moveOpen ? freePositions.map((x) => <Button key={x.id} kind="ghost" title={x.name} onPress={() => move.mutate(x.id, { onSuccess: () => setMoveOpen(false) })} />) : null}
        </>
      ) : null}
      {p.status === 'STOCK' ? (
        <Section title={t('bike.addPart')}>
          {(bikes.data ?? []).filter((b: any) => b.status === 'ACTIVE').map((b: any) => (
            <Button key={b.id} kind={b.id === targetBike ? 'primary' : 'secondary'} small title={b.name} onPress={() => setTargetBike(b.id)} />
          ))}
          {targetBike && targetFree.length === 0 && !target.isLoading ? <P muted small>{t('bike.noParts')}</P> : null}
          {targetFree.map((x) => <Button key={x.id} kind="ghost" title={x.name} onPress={() => move.mutate(x.id, { onSuccess: () => router.back() })} />)}
        </Section>
      ) : null}
      {p.status === 'INSTALLED' ? <Button kind="secondary" title={t('part.stock')} onPress={() => act.mutate('stock', { onSuccess: () => router.back() })} /> : null}
      {p.status !== 'RETIRED' ? (
        <Button kind="danger" title={t('part.retire')} onPress={async () => { if (await confirm(t('part.retire'), p.label, t('part.retire'), true)) act.mutate('retire', { onSuccess: () => router.back() }); }} />
      ) : null}
    </Screen>
  );
}
