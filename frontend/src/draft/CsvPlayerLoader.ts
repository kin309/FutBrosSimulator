import { PlayerRole } from '../game/data/PlayerRole';
import { PlayerStats } from '../game/data/PlayerStats';
import { statsNormalizer } from '../game/data/StatsNormalizer';
import { DraftPlayer } from './DraftTypes';

export async function loadDraftPlayers(url: string): Promise<DraftPlayer[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${url}: ${response.status}`);
  }

  const csv = await response.text();
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];

  const header = rows[0];
  const indexes = Object.fromEntries(header.map((name, index) => [name, index]));

  const players = rows
    .slice(1)
    .filter((row) => row.length === header.length)
    .map((row) => toDraftPlayer(row, indexes));

  statsNormalizer.computeFrom(players.map(p => p.stats));

  return players;
}

function toDraftPlayer(row: string[], indexes: Record<string, number>): DraftPlayer {
  const position = get(row, indexes, 'position');
  const role = toRole(position);
  const firstName = get(row, indexes, 'firstName');
  const lastName = get(row, indexes, 'lastName');
  const commonName = get(row, indexes, 'commonName');
  const name = commonName || [firstName, lastName].filter(Boolean).join(' ') || `Player ${get(row, indexes, 'id')}`;

  return {
    id: get(row, indexes, 'id'),
    name,
    firstName,
    lastName,
    commonName,
    nationality: get(row, indexes, 'nationality'),
    team: get(row, indexes, 'team'),
    leagueName: get(row, indexes, 'leagueName'),
    position,
    role,
    overall: numberValue(row, indexes, 'overallRating'),
    heightCm: numberValue(row, indexes, 'height'),
    weightKg: numberValue(row, indexes, 'weight'),
    stats: toStats(row, indexes, role),
    alternatePositions: splitList(get(row, indexes, 'alternatePositions'), ','),
    alternateRoles: splitList(get(row, indexes, 'alternatePositions'), ',').map(toRole),
    playstyles: splitPlaystyles(get(row, indexes, 'playStyles')),
    playstylesPlus: splitPlaystyles(get(row, indexes, 'playStylesPlus'), true),
  };
}

function splitPlaystyles(raw: string, stripPlus = false): string[] {
  return splitList(raw, ',').map((s) => stripPlus ? s.replace(/\+$/, '') : s);
}

function splitList(raw: string, sep: string): string[] {
  if (!raw) return [];
  return raw.split(sep).map(s => s.trim()).filter(Boolean);
}

function toStats(row: string[], indexes: Record<string, number>, role: PlayerRole): PlayerStats {
  const overall = numberValue(row, indexes, 'overallRating');
  const pace = numberValue(row, indexes, 'pac') || average(
    numberValue(row, indexes, 'gkDiving'),
    numberValue(row, indexes, 'gkReflexes'),
  );
  const passing = numberValue(row, indexes, 'pas') || numberValue(row, indexes, 'gkKicking');
  const shooting = role === PlayerRole.Goalkeeper ? 20 : numberValue(row, indexes, 'sho');
  const dribbling = numberValue(row, indexes, 'dri') || numberValue(row, indexes, 'gkHandling');
  const defending = role === PlayerRole.Goalkeeper
    ? average(
        numberValue(row, indexes, 'gkDiving'),
        numberValue(row, indexes, 'gkPositioning'),
        numberValue(row, indexes, 'gkReflexes'),
      )
    : (numberValue(row, indexes, 'def') || average(
        numberValue(row, indexes, 'gkDiving'),
        numberValue(row, indexes, 'gkPositioning'),
        numberValue(row, indexes, 'gkReflexes'),
      ));
  const physical = numberValue(row, indexes, 'phy') || average(
    numberValue(row, indexes, 'strength'),
    numberValue(row, indexes, 'jumping'),
  );
  const intelligence = role === PlayerRole.Goalkeeper
    ? average(
      numberValue(row, indexes, 'gkReflexes'),
      numberValue(row, indexes, 'gkPositioning'),
      overall,
    )
    : average(
      numberValue(row, indexes, 'reactions'),
      numberValue(row, indexes, 'composure'),
      numberValue(row, indexes, 'positioning'),
      numberValue(row, indexes, 'defensiveAwareness'),
      overall,
    );
  const stamina = numberValue(row, indexes, 'stamina') || Math.max(50, physical);

  // ── Pace ────────────────────────────────────────────────────────────────────
  const acceleration = role === PlayerRole.Goalkeeper
    ? pace : (numberValue(row, indexes, 'acceleration') || pace);
  const sprintSpeed = role === PlayerRole.Goalkeeper
    ? pace : (numberValue(row, indexes, 'sprintSpeed') || pace);

  // ── Shooting ────────────────────────────────────────────────────────────────
  const finishing = role === PlayerRole.Goalkeeper
    ? 20 : (numberValue(row, indexes, 'finishing') || shooting);
  const shotPower = role === PlayerRole.Goalkeeper
    ? average(numberValue(row, indexes, 'gkKicking'), 50)
    : (numberValue(row, indexes, 'shotPower') || shooting);
  const longShots = role === PlayerRole.Goalkeeper
    ? 20 : (numberValue(row, indexes, 'longShots') || shooting);

  // ── Passing ─────────────────────────────────────────────────────────────────
  const shortPassing = role === PlayerRole.Goalkeeper
    ? (numberValue(row, indexes, 'gkKicking') || passing)
    : (numberValue(row, indexes, 'shortPassing') || passing);
  const longPassing = role === PlayerRole.Goalkeeper
    ? (numberValue(row, indexes, 'gkKicking') || passing)
    : (numberValue(row, indexes, 'longPassing') || passing);
  const crossing = role === PlayerRole.Goalkeeper
    ? 20 : (numberValue(row, indexes, 'crossing') || passing);
  const vision = role === PlayerRole.Goalkeeper
    ? average(numberValue(row, indexes, 'gkPositioning'), overall)
    : (numberValue(row, indexes, 'vision')
        || average(numberValue(row, indexes, 'longPassing'), numberValue(row, indexes, 'composure')));

  // ── Dribbling ───────────────────────────────────────────────────────────────
  const agility = numberValue(row, indexes, 'agility') || dribbling;
  const ballControl = role === PlayerRole.Goalkeeper
    ? (numberValue(row, indexes, 'gkHandling') || dribbling)
    : (numberValue(row, indexes, 'ballControl') || dribbling);
  const skillMoves  = numberValue(row, indexes, 'skillMoves')  || 2;
  const weakFootAbility = numberValue(row, indexes, 'weakFootAbility') || 3;
  const preferredFoot   = numberValue(row, indexes, 'preferredFoot')   || 1;

  // ── Defending ───────────────────────────────────────────────────────────────
  const interceptions = role === PlayerRole.Goalkeeper
    ? average(numberValue(row, indexes, 'gkPositioning'), numberValue(row, indexes, 'gkReflexes'))
    : (numberValue(row, indexes, 'interceptions') || defending);

  // ── Physical ────────────────────────────────────────────────────────────────
  const strength = numberValue(row, indexes, 'strength') || physical;
  const balance  = numberValue(row, indexes, 'balance')  || physical;

  // ── Mental ──────────────────────────────────────────────────────────────────
  const composure = role === PlayerRole.Goalkeeper
    ? average(numberValue(row, indexes, 'gkPositioning'), overall)
    : (numberValue(row, indexes, 'composure') || intelligence);
  const reactions = role === PlayerRole.Goalkeeper
    ? average(numberValue(row, indexes, 'gkReflexes'), numberValue(row, indexes, 'gkPositioning'))
    : (numberValue(row, indexes, 'reactions') || intelligence);

  // ── Fitness ─────────────────────────────────────────────────────────────────
  const aggression = numberValue(row, indexes, 'aggression') || Math.max(50, physical);

  return {
    overall,
    speed: pace,
    shooting,
    passing,
    intelligence,
    acceleration,
    sprintSpeed,
    finishing,
    shotPower,
    longShots,
    shortPassing,
    longPassing,
    crossing,
    vision,
    dribbling,
    agility,
    ballControl,
    skillMoves,
    weakFootAbility,
    preferredFoot,
    defending,
    interceptions,
    physical,
    strength,
    balance,
    composure,
    reactions,
    stamina,
    aggression,
  };
}

function toRole(position: string): PlayerRole {
  if (position === 'GK') return PlayerRole.Goalkeeper;
  if (['CB', 'LB', 'RB', 'LWB', 'RWB'].includes(position)) return PlayerRole.Defender;
  if (['LW', 'RW'].includes(position)) return PlayerRole.Winger;
  if (['ST', 'CF'].includes(position)) return PlayerRole.Striker;
  return PlayerRole.Midfielder;
}

function get(row: string[], indexes: Record<string, number>, key: string): string {
  const index = indexes[key];
  return index === undefined ? '' : row[index] ?? '';
}

function numberValue(row: string[], indexes: Record<string, number>, key: string): number {
  const value = Number(get(row, indexes, key));
  return Number.isFinite(value) ? value : 0;
}

function average(...values: number[]): number {
  const valid = values.filter((value) => value > 0);
  if (valid.length === 0) return 0;
  return Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }

  return rows;
}
