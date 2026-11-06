import type { TrafficColor } from '../theme';

export type Counts = Record<TrafficColor, number>;
export interface Me {
  id: string; name: string; email: string; distanceUnit: 'km' | 'mi'; timezone: string;
  thresholds: { yellow: number; orange: number; red: number };
  notifications: { wear: boolean; redWeekly: boolean; strava: boolean };
  termsAccepted: boolean; requiredTermsVersion: string;
  entitlements: Record<string, unknown>;
  strava: { connected: boolean; status?: string; lastSyncAt?: string | null };
}
export interface BikeCard { id: string; name: string; type: string; status?: string; isDefault: boolean; color: TrafficColor; counts: Counts; stravaLinked?: boolean }
export interface Home { bikes: BikeCard[]; unreadCount: number; pendingUpdates: number; strava: { status: string; lastSyncAt: string | null } | null }
export interface PartSummary {
  id: string; label: string; category: string; categoryId: string; modelId: string | null; manufacturer: string | null; isGeneric: boolean;
  status: string; wearsIndoor: boolean; pct: number; color: TrafficColor; overdueLabel: string | null;
  next: { service: string; unit: string | null; remaining: number | null } | null;
  positionId?: string | null; positionName?: string | null;
}
export interface BikeDetail {
  bike: { id: string; name: string; type: string; brand: string | null; model: string | null; year: number | null; status: string; isDefault: boolean; stravaGearId: string | null };
  color: TrafficColor; counts: Counts; parts: PartSummary[];
  positions: Array<{ id: string; name: string; categoryId: string; partId: string | null }>;
}
export interface RuleView {
  serviceId: string; service: string; origin: string; originLabel: string; note: string | null;
  sources: Array<{ id: string; title: string; type: string; url: string | null }>;
  pct: number; color: TrafficColor; overdueLabel: string | null;
  criteria: Array<{ unit: 'km' | 'hours' | 'days'; used: number; limit: number; pct: number; remaining: number }>;
  nextDue: { unit: string; remaining: number } | null; forecastDate: string | null;
}
export interface PartDetail extends PartSummary {
  nickname: string | null; initialKm: number; initialHours: number; disclaimer: string;
  installedOn: { bikeId: string; positionId: string; since: string } | null;
  rules: RuleView[]; history: Array<{ id: string; type: string; at: string; payload: any }>;
}
export interface MaintForm { partId: string; label: string; color: TrafficColor; pct: number; services: Array<{ serviceId: string; name: string; pct: number; preselected: boolean }> }
export interface UpdateView {
  id: string; status: string; description: string; mandatory: boolean;
  parts: Array<{ partId: string; label: string; before: { pct: number; color: TrafficColor }; after: { pct: number; color: TrafficColor }; changed: boolean;
    services: Array<{ service: string; before: { pct: number; color: TrafficColor } | null; after: { pct: number; color: TrafficColor } | null }> }>;
}
export interface ModelRow { id: string; name: string; manufacturer: string | null; isGeneric: boolean }
