export type ExternalMatchedWordRange = {
  wordStart?: number;
  wordEnd?: number;
};

export function combineMatchedWordPositions(
  archiveMatchedPositions: readonly number[],
  externalRanges: readonly ExternalMatchedWordRange[],
  wordCount: number,
) {
  const archivePositions = new Set(
    archiveMatchedPositions.filter((position) => Number.isInteger(position) && position >= 0 && position < wordCount),
  );
  const combinedPositions = new Set(archivePositions);
  for (const range of externalRanges) {
    if (!Number.isInteger(range.wordStart) || !Number.isInteger(range.wordEnd)) continue;
    const start = Math.max(0, range.wordStart!);
    const end = Math.min(wordCount, range.wordEnd!);
    for (let position = start; position < end; position += 1) combinedPositions.add(position);
  }
  return {
    matchedWordCount: combinedPositions.size,
    externalMatchedWordCount: Math.max(0, combinedPositions.size - archivePositions.size),
    score: Math.min(100, Math.round((combinedPositions.size / Math.max(1, wordCount)) * 100)),
  };
}
