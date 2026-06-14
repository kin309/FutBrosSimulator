const POSITION_LABELS: Record<string, string> = {
  GK: 'GOL',
  CB: 'ZAG',
  LB: 'LE',
  RB: 'LD',
  LWB: 'AE',
  RWB: 'AD',
  CDM: 'VOL',
  CM: 'MC',
  CAM: 'MEI',
  LM: 'ME',
  RM: 'MD',
  LW: 'PE',
  RW: 'PD',
  CF: 'SA',
  ST: 'CA',
};

export function positionLabel(position: string): string {
  return POSITION_LABELS[position] ?? position;
}
