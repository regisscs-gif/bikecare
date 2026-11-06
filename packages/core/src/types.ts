/** Tipos do domínio. Tudo em unidades internas: metros e segundos. */

export type Origin = 'USER' | 'MANUFACTURER' | 'PLATFORM';
export type RuleStatus = 'DRAFT' | 'REVIEW' | 'PUBLISHED' | 'ARCHIVED';

/** Limites em unidades de exibição: km, horas, dias. Com mais de um, vale o que ocorrer primeiro. */
export interface Criteria {
  km?: number | null;
  hours?: number | null;
  days?: number | null;
}

export interface Rule {
  id: string;
  /** Alvo: um modelo específico ou uma categoria (genérico). */
  target: { kind: 'model' | 'category'; id: string };
  serviceId: string;
  criteria: Criteria;
  origin: Exclude<Origin, 'USER'>;
  version: number;
  status: RuleStatus;
  note?: string | null;
  sourceIds?: string[];
}

/** Ajuste do usuário sobre uma peça (seção 7: ajustes do usuário). */
export interface UserRuleOverride {
  serviceId: string;
  /** Desligar a regra para esta peça. */
  disabled?: boolean;
  /** Limites ajustados ou, para regra própria, definidos do zero. */
  criteria?: Criteria;
  /** Regra criada pelo usuário (não existe na biblioteca). */
  custom?: boolean;
  /** Origem da regra em que o ajuste se baseia, para exibir "Personalizada (baseada em: ...)". */
  basedOn?: Exclude<Origin, 'USER'>;
}

export interface Part {
  id: string;
  categoryId: string;
  /** null = genérico da categoria */
  modelId: string | null;
  wearsIndoor: boolean;
  status: 'INSTALLED' | 'STOCK' | 'RETIRED';
  /** Uso já rodado antes de cadastrar (entra só na regra "Substituir"). */
  initialKm: number;
  initialHours: number;
}

export interface Installation {
  partId: string;
  bikeId: string;
  positionId: string;
  start: Date;
  /** null = ainda instalada. Intervalo [start, end). */
  end: Date | null;
}

export interface Activity {
  id: string;
  bikeId: string;
  date: Date;
  indoor: boolean;
  distanceM: number;
  movingS: number;
  elapsedS: number;
}

/** Estado de uma regra aplicada a uma peça. Contadores são derivados de eventos. */
export interface PartRuleState {
  partId: string;
  serviceId: string;
  /** Último reset (manutenção do serviço). null = nunca; vale a data de instalação. */
  resetAt: Date | null;
  /** Se a regra é "de vida útil" (ex.: Substituir), o uso inicial entra no contador até o primeiro reset. */
  lifetime?: boolean;
  /** Versão de regra que o usuário escolheu manter (reprocessamento). */
  pinnedRuleId?: string | null;
  /**
   * Uso consolidado (ao desconectar o Strava as atividades são apagadas, mas o contador não se perde).
   * Vale enquanto não houver reset posterior a `at`.
   */
  consolidated?: { at: Date; km: number; hours: number } | null;
}

export interface Usage {
  km: number;
  hours: number;
  days: number;
}

export type CriterionUnit = 'km' | 'hours' | 'days';

export interface CriterionWear {
  unit: CriterionUnit;
  used: number;
  limit: number;
  pct: number;
  remaining: number;
}

export interface RuleWear {
  serviceId: string;
  ruleId: string | null;
  origin: Origin;
  basedOn?: Exclude<Origin, 'USER'>;
  sourceIds: string[];
  note: string | null;
  criteria: CriterionWear[];
  /** Desgaste em % (maior entre os critérios). */
  pct: number;
  /** Critério que vence primeiro. */
  nextDue: CriterionWear | null;
  forecastDate: Date | null;
  usage: Usage;
}

export type TrafficColor = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED';

export interface Thresholds {
  yellow: number;
  orange: number;
  red: number;
}

export interface PartWear {
  partId: string;
  pct: number;
  color: TrafficColor;
  rules: RuleWear[];
  worst: RuleWear | null;
}
