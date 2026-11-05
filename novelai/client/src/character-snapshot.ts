import Ajv from 'ajv';
import contracts from './generated/library-contracts.json';
import type { CharacterSnapshot } from './generated/library-contracts.mjs' with { 'resolution-mode': 'import' };
import type { CharCaptionItem } from './types';
import { LEGACY_STRINGS } from './ui/legacy.strings';

const validate = new Ajv({ strict: false }).compile(contracts.schemas.libraryPayloads.history.properties.characterSnapshot);

/** No defaults, text cleaning, deduplication, or model-dependent truncation. */
export function readCharacterSnapshot(value: unknown): CharacterSnapshot {
  // English message; uiKey lets a dialog render it in the interface language (LEGACY_STRINGS has no imports, so no cycle),
  // code and reason let the host's messages that carry it as a detail (a backup import) render it too (step 4c1).
  if (!validate(value)) throw Object.assign(new Error(LEGACY_STRINGS['hp.snapshotInvalid'][1]), { uiKey: 'hp.snapshotInvalid' as const, code: 'invalid_argument', reason: 'library.character_snapshot_invalid' });
  return structuredClone(value) as CharacterSnapshot;
}

/** Exclude renderer IDs, keeping optional negative text absent rather than inventing it. */
export function snapshotCharacters(captions: readonly CharCaptionItem[]): CharacterSnapshot {
  return readCharacterSnapshot({ version: 1, captions: captions.map(caption => ({
    prompt: caption.prompt,
    ...(Object.hasOwn(caption, 'negativePrompt') ? { negativePrompt: caption.negativePrompt } : {}),
    useCoords: caption.useCoords, x: caption.x, y: caption.y,
  })) });
}
