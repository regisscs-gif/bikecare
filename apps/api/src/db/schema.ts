import { relations, sql } from 'drizzle-orm';
import {
  boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';

const id = () => text('id').primaryKey().$defaultFn(() => crypto.randomUUID());
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const now = (name: string) => ts(name).notNull().defaultNow();

// ───────── Conta, identidade, plano ─────────

export const plans = pgTable('plans', {
  id: text('id').primaryKey(), // free | premium
  name: text('name').notNull(),
});

/** Direitos lidos do servidor, nunca fixos no app (seção 15). */
export const entitlements = pgTable('entitlements', {
  planId: text('plan_id').notNull().references(() => plans.id, { onDelete: 'cascade' }),
  key: text('key').notNull(), // maxActiveBikes, advancedHistory, reports, aiAssistant
  value: jsonb('value').notNull(),
}, (t) => [primaryKey({ columns: [t.planId, t.key] })]);

export const users = pgTable('users', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  photoUrl: text('photo_url'),
  distanceUnit: text('distance_unit').notNull().default('km'), // km | mi
  locale: text('locale').notNull().default('pt-BR'),
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  // Limites do semáforo (seção 9): valem para todas as peças do usuário
  yellowPct: integer('yellow_pct').notNull().default(70),
  orangePct: integer('orange_pct').notNull().default(85),
  redPct: integer('red_pct').notNull().default(100),
  planId: text('plan_id').notNull().default('free').references(() => plans.id),
  termsVersion: text('terms_version'),
  termsAcceptedAt: ts('terms_accepted_at'),
  notifyWear: boolean('notify_wear').notNull().default(true),
  notifyRedWeekly: boolean('notify_red_weekly').notNull().default(true),
  notifyStrava: boolean('notify_strava').notNull().default(true),
  createdAt: now('created_at'),
});

/** Identidade separada da conta: Google hoje, Apple depois, sem migrar dados. */
export const identities = pgTable('identities', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(), // GOOGLE | APPLE
  subject: text('subject').notNull(),
}, (t) => [uniqueIndex('identities_provider_subject').on(t.provider, t.subject)]);

export const userEntitlements = pgTable('user_entitlements', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.key] })]);

export const stravaConnections = pgTable('strava_connections', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  athleteId: text('athlete_id').notNull().unique(),
  accessTokenEnc: text('access_token_enc').notNull(),
  refreshTokenEnc: text('refresh_token_enc').notNull(),
  expiresAt: ts('expires_at').notNull(),
  scope: text('scope').notNull(),
  status: text('status').notNull().default('OK'), // OK | ERROR | REVOKED
  lastSyncAt: ts('last_sync_at'),
});

export const pushTokens = pgTable('push_tokens', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  token: text('token').notNull().unique(),
});

// ───────── Biblioteca (administrada no painel) ─────────

export const categories = pgTable('categories', {
  id: text('id').primaryKey(), // C01...
  name: text('name').notNull().unique(),
  wearsIndoorDefault: text('wears_indoor_default').notNull().default('NO'), // YES | NO | NA
  typicalCriterion: text('typical_criterion'),
  bikeTypesNote: text('bike_types_note'),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const services = pgTable('services', {
  id: id(),
  name: text('name').notNull(),
  /** Serviços de vida útil recebem o uso inicial de peça usada (ex.: Substituir). */
  lifetime: boolean('lifetime').notNull().default(false),
  /** null = serviço da biblioteca; preenchido = serviço criado pelo usuário numa regra própria. */
  ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
}, (t) => [
  uniqueIndex('services_library_name').on(t.name).where(sql`${t.ownerUserId} is null`),
  uniqueIndex('services_owner_name').on(t.ownerUserId, t.name).where(sql`${t.ownerUserId} is not null`),
]);

export const categoryServices = pgTable('category_services', {
  categoryId: text('category_id').notNull().references(() => categories.id, { onDelete: 'cascade' }),
  serviceId: text('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.categoryId, t.serviceId] })]);

export const manufacturers = pgTable('manufacturers', {
  id: text('id').primaryKey(), // FB001...
  name: text('name').notNull().unique(),
  site: text('site'),
});

export const models = pgTable('models', {
  id: text('id').primaryKey(), // MD0001... ou G01 (genérico)
  manufacturerId: text('manufacturer_id').references(() => manufacturers.id),
  categoryId: text('category_id').notNull().references(() => categories.id),
  name: text('name').notNull(),
  code: text('code'),
  speeds: text('speeds'),
  segment: text('segment'),
  bikeTypes: text('bike_types'),
  priorityBR: text('priority_br'),
  evidence: text('evidence'),
  isGeneric: boolean('is_generic').notNull().default(false),
}, (t) => [index('models_category').on(t.categoryId), index('models_manufacturer').on(t.manufacturerId)]);

export const sources = pgTable('sources', {
  id: text('id').primaryKey(), // F01...
  type: text('type').notNull(),
  title: text('title').notNull(),
  url: text('url'),
  filePath: text('file_path'),
  page: text('page'),
  consultedAt: ts('consulted_at').notNull(),
});

/** Regra versionada: editar uma publicada cria nova versão em rascunho (seção 13). */
export const rules = pgTable('rules', {
  id: id(),
  groupId: text('group_id').notNull(),
  version: integer('version').notNull().default(1),
  status: text('status').notNull().default('DRAFT'), // DRAFT | REVIEW | PUBLISHED | ARCHIVED
  origin: text('origin').notNull(), // MANUFACTURER | PLATFORM
  modelId: text('model_id').references(() => models.id),
  categoryId: text('category_id').references(() => categories.id),
  serviceId: text('service_id').notNull().references(() => services.id),
  kmLimit: doublePrecision('km_limit'),
  hoursLimit: doublePrecision('hours_limit'),
  daysLimit: doublePrecision('days_limit'),
  note: text('note'),
  confidence: text('confidence'),
  importId: text('import_id'),
  createdBy: text('created_by'),
  reviewedBy: text('reviewed_by'),
  publishedAt: ts('published_at'),
  createdAt: now('created_at'),
}, (t) => [index('rules_status_model').on(t.status, t.modelId), index('rules_status_cat').on(t.status, t.categoryId)]);

export const ruleSources = pgTable('rule_sources', {
  ruleId: text('rule_id').notNull().references(() => rules.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull().references(() => sources.id),
}, (t) => [primaryKey({ columns: [t.ruleId, t.sourceId] })]);

export const bikeTypeTemplates = pgTable('bike_type_templates', {
  id: id(),
  bikeType: text('bike_type').notNull(),
  categoryId: text('category_id').notNull().references(() => categories.id),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [index('btt_type').on(t.bikeType)]);

export const modelSuggestions = pgTable('model_suggestions', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  categoryId: text('category_id').notNull().references(() => categories.id),
  manufacturer: text('manufacturer').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull().default('PENDING'), // PENDING | ACCEPTED | REJECTED
  createdAt: now('created_at'),
});

// ───────── Bike, posição, peça, instalação ─────────

export const bikes = pgTable('bikes', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  brand: text('brand'),
  model: text('model'),
  year: integer('year'),
  stravaGearId: text('strava_gear_id'),
  photoUrl: text('photo_url'),
  status: text('status').notNull().default('ACTIVE'), // ACTIVE | ARCHIVED
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: now('created_at'),
}, (t) => [
  index('bikes_user').on(t.userId),
  uniqueIndex('bikes_user_strava').on(t.userId, t.stravaGearId).where(sql`${t.stravaGearId} is not null`),
]);

export const positions = pgTable('positions', {
  id: id(),
  bikeId: text('bike_id').notNull().references(() => bikes.id, { onDelete: 'cascade' }),
  categoryId: text('category_id').notNull().references(() => categories.id),
  name: text('name').notNull(),
  /** Posição removida pelo usuário: some das listas, mas o histórico de instalações permanece. */
  removedAt: ts('removed_at'),
});

export const parts = pgTable('parts', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  categoryId: text('category_id').notNull().references(() => categories.id),
  modelId: text('model_id').references(() => models.id), // null = genérico da categoria
  nickname: text('nickname'),
  initialKm: doublePrecision('initial_km').notNull().default(0),
  initialHours: doublePrecision('initial_hours').notNull().default(0),
  wearsIndoor: boolean('wears_indoor').notNull().default(false),
  status: text('status').notNull().default('INSTALLED'), // INSTALLED | STOCK | RETIRED
  createdAt: now('created_at'),
}, (t) => [index('parts_user_status').on(t.userId, t.status)]);

/** Período em que uma peça ficou numa posição. O uso é somado por período de instalação. */
export const installations = pgTable('installations', {
  id: id(),
  partId: text('part_id').notNull().references(() => parts.id, { onDelete: 'cascade' }),
  bikeId: text('bike_id').notNull().references(() => bikes.id, { onDelete: 'cascade' }),
  positionId: text('position_id').notNull().references(() => positions.id, { onDelete: 'cascade' }),
  startedAt: ts('started_at').notNull(),
  endedAt: ts('ended_at'),
}, (t) => [index('inst_part').on(t.partId), index('inst_bike').on(t.bikeId, t.startedAt)]);

/** Estado + ajustes de uma regra aplicada a uma peça (um contador por serviço). */
export const partRules = pgTable('part_rules', {
  id: id(),
  partId: text('part_id').notNull().references(() => parts.id, { onDelete: 'cascade' }),
  serviceId: text('service_id').notNull().references(() => services.id),
  resetAt: ts('reset_at'),
  disabled: boolean('disabled').notNull().default(false),
  custom: boolean('custom').notNull().default(false),
  userKm: doublePrecision('user_km'),
  userHours: doublePrecision('user_hours'),
  userDays: doublePrecision('user_days'),
  basedOn: text('based_on'), // MANUFACTURER | PLATFORM
  pinnedRuleId: text('pinned_rule_id'), // "Manter como está" (seção 14)
  /** "Uso consolidado até <data>": guardado ao desconectar o Strava, quando as atividades importadas são apagadas. */
  consolidatedAt: ts('consolidated_at'),
  consolidatedKm: doublePrecision('consolidated_km'),
  consolidatedHours: doublePrecision('consolidated_hours'),
}, (t) => [uniqueIndex('part_rules_part_service').on(t.partId, t.serviceId)]);

export const partHistory = pgTable('part_history', {
  id: id(),
  partId: text('part_id').notNull().references(() => parts.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // INSTALLED | MOVED | STOCKED | RETIRED | MAINTENANCE | MODEL_CHANGED | RULE_ADJUSTED | REPROCESSED
  at: now('at'),
  payload: jsonb('payload'),
}, (t) => [index('part_history_part').on(t.partId, t.at)]);

// ───────── Atividades, manutenção, gastos ─────────

/** Só o necessário: sem trajeto GPS, frequência cardíaca ou potência (LGPD / Strava). */
export const activities = pgTable('activities', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bikeId: text('bike_id').notNull().references(() => bikes.id, { onDelete: 'cascade' }),
  source: text('source').notNull(), // STRAVA | MANUAL
  kind: text('kind').notNull().default('RIDE'), // RIDE | ADJUSTMENT
  externalId: text('external_id'),
  date: ts('date').notNull(),
  type: text('type'),
  indoor: boolean('indoor').notNull().default(false),
  distanceM: doublePrecision('distance_m').notNull().default(0),
  movingS: doublePrecision('moving_s').notNull().default(0),
  elapsedS: doublePrecision('elapsed_s').notNull().default(0),
  note: text('note'),
  createdAt: now('created_at'),
}, (t) => [
  index('activities_bike_date').on(t.bikeId, t.date),
  uniqueIndex('activities_ext').on(t.userId, t.source, t.externalId).where(sql`${t.externalId} is not null`),
]);

export const maintenanceRecords = pgTable('maintenance_records', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bikeId: text('bike_id').notNull().references(() => bikes.id, { onDelete: 'cascade' }),
  date: ts('date').notNull(),
  /** Instante do reset dos contadores: agora (se a data é hoje) ou fim do dia (se passada). */
  resetAt: ts('reset_at').notNull(),
  shop: text('shop'),
  partsCostCents: integer('parts_cost_cents').notNull().default(0),
  laborCostCents: integer('labor_cost_cents').notNull().default(0),
  notes: text('notes'),
  createdAt: now('created_at'),
});

export const maintenanceItems = pgTable('maintenance_items', {
  id: id(),
  recordId: text('record_id').notNull().references(() => maintenanceRecords.id, { onDelete: 'cascade' }),
  partId: text('part_id').notNull().references(() => parts.id),
  serviceIds: text('service_ids').array().notNull().default(sql`'{}'::text[]`),
  replaced: boolean('replaced').notNull().default(false),
  other: text('other'),
  kmAtDate: doublePrecision('km_at_date').notNull().default(0),
  hoursAtDate: doublePrecision('hours_at_date').notNull().default(0),
});

export const expenses = pgTable('expenses', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bikeId: text('bike_id').notNull().references(() => bikes.id, { onDelete: 'cascade' }),
  date: ts('date').notNull(),
  amountCents: integer('amount_cents').notNull(),
  category: text('category').notNull(), // PARTS | MAINTENANCE | LABOR | ACCESSORIES | TOOLS | TIRES | OTHER
  description: text('description'),
  partId: text('part_id').references(() => parts.id, { onDelete: 'set null' }),
  recordId: text('record_id').references(() => maintenanceRecords.id, { onDelete: 'cascade' }),
}, (t) => [index('expenses_user_date').on(t.userId, t.date)]);

// ───────── Notificações e atualizações de dados ─────────

export const notifications = pgTable('notifications', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // WEAR_YELLOW | WEAR_ORANGE | WEAR_RED | RED_REMINDER | TIME_RULE | STRAVA_ERROR | DATA_UPDATE
  partId: text('part_id').references(() => parts.id, { onDelete: 'set null' }),
  text: text('text').notNull(),
  push: boolean('push').notNull().default(false),
  pushedAt: ts('pushed_at'), // nulo com push=true => pendente (horário silencioso / limite diário)
  read: boolean('read').notNull().default(false),
  createdAt: now('created_at'),
}, (t) => [index('notifications_user').on(t.userId, t.read, t.createdAt)]);

/** Última cor notificada: o aviso dispara uma vez por mudança para cor pior (seção 12). */
export const partColorState = pgTable('part_color_state', {
  partId: text('part_id').primaryKey().references(() => parts.id, { onDelete: 'cascade' }),
  color: text('color').notNull().default('GREEN'),
  notifiedColor: text('notified_color').notNull().default('GREEN'),
  lastRedReminder: ts('last_red_reminder'),
});

export const dataUpdates = pgTable('data_updates', {
  id: id(),
  kind: text('kind').notNull(), // RULE_VERSION | DATA_UPDATE
  mandatory: boolean('mandatory').notNull().default(false),
  description: text('description').notNull(),
  newRuleIds: text('new_rule_ids').array().notNull().default(sql`'{}'::text[]`),
  createdAt: now('created_at'),
});

export const dataUpdateDecisions = pgTable('data_update_decisions', {
  updateId: text('update_id').notNull().references(() => dataUpdates.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('PENDING'), // PENDING | APPLIED | DECLINED | LATER
  decidedAt: ts('decided_at'),
}, (t) => [primaryKey({ columns: [t.updateId, t.userId] })]);

// ───────── Painel administrativo ─────────

export const staffMembers = pgTable('staff_members', {
  email: text('email').primaryKey(),
  role: text('role').notNull(), // ADMIN | CURATOR | REVIEWER | SUPPORT
});

export const auditLog = pgTable('audit_log', {
  id: id(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  payload: jsonb('payload'),
  createdAt: now('created_at'),
}, (t) => [index('audit_entity').on(t.entity, t.entityId)]);

export const usersRelations = relations(users, ({ many }) => ({ bikes: many(bikes), parts: many(parts) }));
export const bikesRelations = relations(bikes, ({ many }) => ({ positions: many(positions) }));

// ───────── Configuração e filas ─────────

/** Configuração em vez de código: tipos de atividade do Strava aceitos etc. (seção 13). */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

/** Fila de eventos do Strava com nova tentativa (limite de uso da API, falhas). */
export const stravaJobs = pgTable('strava_jobs', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // INITIAL | ACTIVITY
  objectId: text('object_id'),
  aspect: text('aspect'), // create | update | delete
  updates: jsonb('updates'),
  status: text('status').notNull().default('PENDING'), // PENDING | DONE | FAILED
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: now('next_attempt_at'),
  lastError: text('last_error'),
  createdAt: now('created_at'),
}, (t) => [index('strava_jobs_due').on(t.status, t.nextAttemptAt)]);
