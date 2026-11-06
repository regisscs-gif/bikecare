import React from 'react';
import {
  ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View,
  type StyleProp, type TextInputProps, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, soft, space, type TrafficColor } from '../theme';
import { t } from '../i18n';

export function Screen({ children, scroll = true, pad = true }: { children: React.ReactNode; scroll?: boolean; pad?: boolean }) {
  const ins = useSafeAreaInsets();
  const inner = { padding: pad ? space.lg : 0, paddingBottom: ins.bottom + space.xl, gap: space.md, maxWidth: 720, width: '100%' as const, alignSelf: 'center' as const };
  return scroll ? (
    <ScrollView style={s.screen} contentContainerStyle={inner} keyboardShouldPersistTaps="handled">{children}</ScrollView>
  ) : (
    <View style={[s.screen, inner]}>{children}</View>
  );
}

export const H1 = ({ children }: { children: React.ReactNode }) => <Text accessibilityRole="header" style={s.h1}>{children}</Text>;
export const H2 = ({ children }: { children: React.ReactNode }) => <Text accessibilityRole="header" style={s.h2}>{children}</Text>;
export const P = ({ children, muted, small, style }: { children: React.ReactNode; muted?: boolean; small?: boolean; style?: StyleProp<any> }) => (
  <Text style={[s.p, muted && { color: colors.muted }, small && { fontSize: 13 }, style]}>{children}</Text>
);

export function Card({ children, onPress, style }: { children: React.ReactNode; onPress?: () => void; style?: StyleProp<ViewStyle> }) {
  if (onPress) {
    return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.card, style, pressed && { opacity: 0.85 }]}>{children}</Pressable>;
  }
  return <View style={[s.card, style]}>{children}</View>;
}

export function Button({ title, onPress, kind = 'primary', loading, disabled, small }: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger' | 'ghost'; loading?: boolean; disabled?: boolean; small?: boolean;
}) {
  const bg = kind === 'primary' ? colors.primary : kind === 'danger' ? colors.danger : kind === 'secondary' ? colors.card : 'transparent';
  const fg = kind === 'primary' || kind === 'danger' ? colors.primaryText : kind === 'ghost' ? colors.primary : colors.text;
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button" accessibilityState={{ disabled: !!off }} disabled={off} onPress={onPress}
      style={({ pressed }) => [s.btn, small && { paddingVertical: 8 }, { backgroundColor: bg, borderColor: kind === 'secondary' ? colors.line : bg }, off && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, hint, error, ...props }: TextInputProps & { label: string; hint?: string; error?: string | null }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.muted} {...props} style={[s.input, error ? { borderColor: colors.danger } : null, props.style]} accessibilityLabel={label} />
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
      {error ? <Text style={[s.hint, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  );
}

export function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.row}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.p}>{label}</Text>
        {hint ? <Text style={s.hint}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
    </View>
  );
}

export function Check({ label, checked, onChange, sub }: { label: string; checked: boolean; onChange: (v: boolean) => void; sub?: string }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={() => onChange(!checked)} style={s.row}>
      <View style={[s.box, checked && { backgroundColor: colors.primary, borderColor: colors.primary }]}>{checked ? <Text style={{ color: '#fff', fontWeight: '800' }}>✓</Text> : null}</View>
      <View style={{ flex: 1 }}>
        <Text style={s.p}>{label}</Text>
        {sub ? <Text style={s.hint}>{sub}</Text> : null}
      </View>
    </Pressable>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void }) {
  return (
    <View style={s.seg}>
      {options.map((o) => (
        <Pressable key={o.value} accessibilityRole="button" accessibilityState={{ selected: o.value === value }} onPress={() => onChange(o.value)}
          style={[s.segItem, o.value === value && { backgroundColor: colors.primary }]}>
          <Text style={{ color: o.value === value ? '#fff' : colors.text, fontWeight: '600', fontSize: 13 }}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Chip chip do semáforo. Sempre traz texto: a cor nunca é a única informação. */
export function TrafficPill({ color, text }: { color: TrafficColor; text?: string }) {
  return (
    <View style={[s.pill, { backgroundColor: soft[color] }]} accessible accessibilityLabel={text ?? t(`color.${color}`)}>
      <View style={[s.dot, { backgroundColor: colors[color] }]} />
      <Text style={{ color: colors.text, fontWeight: '600', fontSize: 12 }}>{text ?? t(`color.${color}`)}</Text>
    </View>
  );
}

export function ProgressBar({ pct, color }: { pct: number; color: TrafficColor }) {
  return (
    <View style={s.track} accessible accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.min(100, Math.round(pct)) }}>
      <View style={{ width: `${Math.min(100, Math.max(2, pct))}%`, height: '100%', backgroundColor: colors[color], borderRadius: 4 }} />
    </View>
  );
}

export function Counts({ counts }: { counts: Record<TrafficColor, number> }) {
  const order: TrafficColor[] = ['RED', 'ORANGE', 'YELLOW', 'GREEN'];
  return (
    <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
      {order.filter((c) => counts[c] > 0).map((c) => (
        <View key={c} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <View style={[s.dot, { backgroundColor: colors[c] }]} />
          <Text style={s.hint}>{counts[c]} {t(`color.${c}`).toLowerCase()}</Text>
        </View>
      ))}
    </View>
  );
}

export function Loading() {
  return <View style={{ padding: space.xl }}><ActivityIndicator /></View>;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = (error as any)?.message ?? t('error.generic');
  return (
    <Card>
      <Text style={[s.p, { color: colors.danger }]}>{msg}</Text>
      {onRetry ? <Button title={t('common.retry')} kind="secondary" onPress={onRetry} small /> : null}
    </Card>
  );
}

export const Empty = ({ text }: { text: string }) => <Text style={[s.p, { color: colors.muted, textAlign: 'center', padding: space.xl }]}>{text}</Text>;
export const Row = ({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) => <View style={[s.row, style]}>{children}</View>;
export const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <View style={{ gap: space.sm }}><H2>{title}</H2>{children}</View>
);

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  h1: { fontSize: 26, fontWeight: '800', color: colors.text },
  h2: { fontSize: 17, fontWeight: '700', color: colors.text },
  p: { fontSize: 15, color: colors.text, lineHeight: 21 },
  label: { fontSize: 13, fontWeight: '600', color: colors.muted },
  hint: { fontSize: 12, color: colors.muted, lineHeight: 16 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: space.lg, gap: space.sm, borderWidth: 1, borderColor: colors.line },
  btn: { paddingVertical: 13, paddingHorizontal: 16, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1, minHeight: 44 },
  btnText: { fontSize: 15, fontWeight: '700' },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: Platform.OS === 'web' ? 10 : 11, fontSize: 16, backgroundColor: '#fff', color: colors.text, minHeight: 44 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  seg: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  segItem: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: '#fff' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, paddingHorizontal: 10, borderRadius: radius.pill, alignSelf: 'flex-start' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: 'hidden' },
});
