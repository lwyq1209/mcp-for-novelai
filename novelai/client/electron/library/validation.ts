import Ajv from 'ajv';
import contracts from '../../src/generated/library-contracts.json';
import type { LibraryKind } from './types';
import { hostError } from '../host-error';

const ajv = new Ajv({ strict: false, strictNumbers: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const validators = Object.fromEntries(Object.entries(contracts.schemas.libraryPayloads).map(([kind, schema]) => [kind, ajv.compile(schema)]));
const generatedHistory = ajv.compile(contracts.schemas.generatedHistoryPayload);
const requestValidators = Object.fromEntries(Object.entries(contracts.schemas.requests).map(([name, schema]) => [name, ajv.compile(schema)]));

export function validateLibraryRequest(name: keyof typeof contracts.schemas.requests, value: unknown): void {
  const validate = requestValidators[name];
  if (!validate(value)) { const detail = ajv.errorsText(validate.errors); throw hostError('invalid_argument', `Invalid library request: ${detail}`, 'library.invalid_request', { detail }); }
}

/**
 * Every library write checks the stored record against the one storage schema, without coercing authored values or
 * filling in defaults. A stored history record keeps its generation parameters as they were saved (sparse).
 */
export function validateLibraryPayload(kind: LibraryKind, payload: unknown): void {
  const validate = validators[kind];
  if (!validate || !validate(payload)) { const detail = validate ? ajv.errorsText(validate.errors) : 'unknown kind'; throw hostError('invalid_argument', `Invalid library fields: ${detail}`, 'library.invalid_fields', { detail }); }
}

/** A new history record from generation, with its complete generation parameters: checked before the request is sent
 * (ipc/nai.ts refuseUnsavableHistory) and where the record is saved (ipc/store.ts addHistory). */
export function validateGeneratedHistoryPayload(payload: unknown): void {
  if (!generatedHistory(payload)) { const detail = ajv.errorsText(generatedHistory.errors); throw hostError('invalid_argument', `Invalid generation history fields: ${detail}`, 'library.invalid_history_fields', { detail }); }
}
