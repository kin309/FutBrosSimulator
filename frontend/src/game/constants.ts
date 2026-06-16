import type { FieldBounds, GoalBounds } from './types';

export const GAME_WIDTH  = 1200;
export const GAME_HEIGHT = 760;
export const HUD_HEIGHT  = 58;

export const FIELD: FieldBounds = {
  left: 20, right: 1180, top: 76, bottom: 744,
  centerX: 600, centerY: 410,
};

export const GOAL_HEIGHT = 192;

export const GOAL_LEFT: GoalBounds  = { centerX: 10,   top: FIELD.centerY - GOAL_HEIGHT / 2, bottom: FIELD.centerY + GOAL_HEIGHT / 2 };
export const GOAL_RIGHT: GoalBounds = { centerX: 1190, top: FIELD.centerY - GOAL_HEIGHT / 2, bottom: FIELD.centerY + GOAL_HEIGHT / 2 };

export const GOAL_LINE_LEFT  = FIELD.left;
export const GOAL_LINE_RIGHT = FIELD.right;
