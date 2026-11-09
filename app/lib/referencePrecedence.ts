export interface RefPrecedenceInput {
  manualCount: number;
  styleHasRef: boolean;
  characterRefCount: number;
  /** null = model doesn't support refs; Infinity = no cap */
  limit: number | null;
}

export interface RefPrecedenceResult {
  keepManual: number;
  keepStyle: 0 | 1;
  keepCharacter: number;
  droppedManual: number;
  droppedStyle: 0 | 1;
  droppedCharacter: number;
  totalDropped: number;
}

/**
 * Greedy allocation by priority: manual → style → character.
 * If limit is null, no refs are accepted by the model at all.
 */
export function computeReferencePrecedence(input: RefPrecedenceInput): RefPrecedenceResult {
  const { manualCount, styleHasRef, characterRefCount, limit } = input;
  const styleCount = styleHasRef ? 1 : 0;
  const total = manualCount + styleCount + characterRefCount;

  if (limit === null) {
    return {
      keepManual: 0,
      keepStyle: 0,
      keepCharacter: 0,
      droppedManual: manualCount,
      droppedStyle: styleCount as 0 | 1,
      droppedCharacter: characterRefCount,
      totalDropped: total,
    };
  }

  const cap = Number.isFinite(limit) ? limit : Infinity;

  const keepManual = Math.min(manualCount, cap);
  const remaining1 = Math.max(0, cap - keepManual);

  const keepStyle = Math.min(styleCount, remaining1) as 0 | 1;
  const remaining2 = Math.max(0, remaining1 - keepStyle);

  const keepCharacter = Math.min(characterRefCount, remaining2);

  const droppedManual = manualCount - keepManual;
  const droppedStyle = (styleCount - keepStyle) as 0 | 1;
  const droppedCharacter = characterRefCount - keepCharacter;

  return {
    keepManual,
    keepStyle,
    keepCharacter,
    droppedManual,
    droppedStyle,
    droppedCharacter,
    totalDropped: droppedManual + droppedStyle + droppedCharacter,
  };
}

/** How many references will actually be sent after precedence truncation. */
export function countKeptReferences(input: RefPrecedenceInput): number {
  const { keepManual, keepStyle, keepCharacter } = computeReferencePrecedence(input);
  return keepManual + keepStyle + keepCharacter;
}
