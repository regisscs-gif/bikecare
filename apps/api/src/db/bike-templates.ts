/** Posições sugeridas por tipo de bike (seção 5). Configuráveis no painel; estes são os padrões iniciais. */
export type BikeType =
  | 'MTB_XC' | 'MTB_FULL' | 'ENDURO' | 'DOWNHILL' | 'ROAD' | 'GRAVEL' | 'URBAN' | 'EBIKE' | 'BMX' | 'TRIATHLON' | 'OTHER';

export const BIKE_TYPES: BikeType[] = [
  'MTB_XC', 'MTB_FULL', 'ENDURO', 'DOWNHILL', 'ROAD', 'GRAVEL', 'URBAN', 'EBIKE', 'BMX', 'TRIATHLON', 'OTHER',
];

type P = [categoryId: string, name: string];

const drivetrain: P[] = [
  ['C01', 'Corrente'], ['C02', 'Cassete / roda livre'], ['C03', 'Pedivela e coroas'],
  ['C04', 'Câmbio traseiro'], ['C07', 'Movimento central'], ['C08', 'Pedais'], ['C19', 'Cabos e conduítes'],
];
const wheels: P[] = [
  ['C14', 'Pneu dianteiro'], ['C14', 'Pneu traseiro'], ['C21', 'Roda dianteira'], ['C21', 'Roda traseira'], ['C20', 'Caixa de direção'],
];
const discBrakes: P[] = [
  ['C09', 'Freio dianteiro'], ['C09', 'Freio traseiro'],
  ['C11', 'Pastilha dianteira'], ['C11', 'Pastilha traseira'],
  ['C12', 'Disco dianteiro'], ['C12', 'Disco traseiro'],
];
const rimBrakes: P[] = [['C13', 'Freio dianteiro'], ['C13', 'Freio traseiro']];
const tubeless: P[] = [['C15', 'Selante dianteiro'], ['C15', 'Selante traseiro']];
const fork: P[] = [['C16', 'Suspensão dianteira']];
const shock: P[] = [['C17', 'Suspensão traseira']];
const dropper: P[] = [['C18', 'Canote retrátil']];

export const BIKE_TEMPLATES: Record<BikeType, P[]> = {
  MTB_XC: [...drivetrain, ...wheels, ...discBrakes, ...tubeless, ...fork],
  MTB_FULL: [...drivetrain, ...wheels, ...discBrakes, ...tubeless, ...fork, ...shock, ...dropper],
  ENDURO: [...drivetrain, ...wheels, ...discBrakes, ...tubeless, ...fork, ...shock, ...dropper],
  DOWNHILL: [...drivetrain.filter(([c]) => c !== 'C04' || true), ...wheels, ...discBrakes, ...fork, ...shock],
  ROAD: [...drivetrain, ['C05', 'Câmbio dianteiro'], ['C06', 'Trocador / passador'], ...wheels, ...discBrakes, ['C22', 'Fita de guidão']],
  GRAVEL: [...drivetrain, ...wheels, ...discBrakes, ...tubeless, ['C22', 'Fita de guidão']],
  URBAN: [...drivetrain, ...wheels, ...rimBrakes],
  EBIKE: [...drivetrain, ...wheels, ...discBrakes, ['C23', 'Motor e bateria']],
  BMX: [['C01', 'Corrente'], ['C03', 'Pedivela e coroas'], ['C07', 'Movimento central'], ['C08', 'Pedais'], ...wheels, ...rimBrakes],
  TRIATHLON: [...drivetrain, ['C05', 'Câmbio dianteiro'], ...wheels, ['C13', 'Freio dianteiro'], ['C13', 'Freio traseiro']],
  OTHER: [['C01', 'Corrente'], ...wheels, ...rimBrakes],
};
