import Ajv from 'ajv';
// A static JSON import (not createRequire), so the single-file MCP bundle carries the schemas.
import contracts from './generated/library-contracts.json' with { type: 'json' };

export const contractSchemas = contracts.schemas;
const ajv = new Ajv({
  strict: false, strictNumbers: true, ownProperties: true, allErrors: false,
  coerceTypes: false, useDefaults: false, removeAdditional: false, validateFormats: false,
});
const validators = new WeakMap();

export class ContractValidationError extends Error {
  constructor(message) { super(message); this.code = 'invalid_arguments'; }
}

/** Ajv owns structural validation; service-level identity, paths and budgets remain authoritative. */
export function validateContract(value, schema) {
  let validate = validators.get(schema);
  if (!validate) { validate = ajv.compile(schema); validators.set(schema, validate); }
  if (validate(value)) return value;
  const error = validate.errors?.[0];
  throw new ContractValidationError(`arguments${error?.instancePath ?? ''} ${error?.message ?? 'does not match the contract'}.`);
}

export function validateMaterialRequest(method, value) {
  const schema = contractSchemas.requests[method];
  if (!schema) throw new ContractValidationError('Unknown material request contract.');
  return validateContract(value, schema);
}
