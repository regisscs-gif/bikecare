export const colors = {
  bg: '#F5F6F8',
  card: '#FFFFFF',
  text: '#14171F',
  muted: '#5F6877',
  line: '#E3E6EC',
  primary: '#1F6FEB',
  primaryText: '#FFFFFF',
  danger: '#C62F2F',
  GREEN: '#2E9E5B',
  YELLOW: '#E3B100',
  ORANGE: '#EE7C1A',
  RED: '#D8362F',
} as const;

export type TrafficColor = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED';

/** Fundo suave de cada cor (para chips), sem depender só da cor: o texto sempre diz o estado. */
export const soft: Record<TrafficColor, string> = {
  GREEN: '#E5F5EC', YELLOW: '#FBF3D3', ORANGE: '#FDE9D6', RED: '#FBE0DE',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;
