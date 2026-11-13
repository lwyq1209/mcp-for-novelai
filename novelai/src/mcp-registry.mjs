/**
 * Tool registry and dispatch for the NovelAI MCP server (src/mcp.mjs).
 *
 * Every tool is one fixed entry:
 *   { name, layer: 'core' | 'canvas', description, inputSchema, annotations,
 *     hostMethods: [...], errors: 'core-messages' | 'opaque',
 *     precheck?(args), validate?(args), async handle(args, ctx) }
 * tools/list publishes only name/description/inputSchema/annotations. A call runs
 * precheck → the flat public schema → the tool's own validate (branch and
 * cross-field rules) before the handler may reach the host. Names that are not
 * registered (including the raw host method names and former tool names) are
 * unknown_tool and send nothing to the host.
 *
 * The only host access is ctx.bridge, the guarded client: a non-BridgeError from
 * the transport becomes HostCallError (outcome unknown, reported opaquely).
 * Every handler runs inside its own host-call scope (business-guards hostCallScope):
 * the guarded bridge then refuses, before sending, any method outside that tool's
 * fixed hostMethods — also from modules built once per server, such as the recipe
 * queue. Such a call fails as host_method_not_allowed, whatever the tool did with
 * the refusal.
 */
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ContractValidationError, validateContract } from '../contracts/validate.mjs';
import { BridgeError, sanitize } from './bridge-client.mjs';
import { HostCallError, HostCallOutsideToolError, HostMethodNotAllowedError, callerClient, hostCallScope, scrubDeep, scrubMessages, scrubText, trustedIdentities } from './business-guards.mjs';
import { AssetSummaryError } from './asset-library-response.mjs';
import { QueueControlError } from './queue-control.mjs';

export const LAYERS = Object.freeze(['core', 'canvas']);
export const ERROR_POLICIES = Object.freeze(['core-messages', 'opaque']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const NODE_SYSTEM_CODE = /^E[A-Z]+$/; // errno codes (ENOENT, ELOOP, EISDIR…), not ERR_* programming errors
const DOMAIN_CODE = /^[a-z][a-z0-9_.-]{0,79}$/;
const FILE_UNAVAILABLE = 'The requested inbox/export file or directory is unavailable. Use a direct regular file in the documented inbox; no paths, URLs or symlinks.';
/** Opaque failure text per layer (unchanged from the two former servers). */
export const INTERNAL_MESSAGES = Object.freeze({
  core: 'The business tool failed. Read current state before continuing.',
  canvas: 'The workspace tool failed. Read current state before continuing.',
});
const UNKNOWN_TOOL = 'This NovelAI tool does not exist. Use only the names listed by tools/list.';
/** A tool reached a host method outside its fixed list: a server defect, refused before anything was sent for it. */
const hostMethodNotAllowed = (tool, denied) => ({ code: 'host_method_not_allowed', message: `${tool} tried to call host method${denied.length > 1 ? 's' : ''} ${[...new Set(denied)].join(', ')} outside its fixed list; nothing was sent for ${denied.length > 1 ? 'them' : 'it'}. This is a server defect, not an argument problem: do not retry; read current state before continuing.` });

/** Schema check before any host call; contract failures become invalid_arguments. */
export function validateArguments(value, schema) {
  try { validateContract(value, schema); }
  catch (error) {
    if (error instanceof ContractValidationError) throw new BridgeError('invalid_arguments', error.message);
    throw error;
  }
}

export function imageBlock(asset, reread = 'Read it again.') {
  if (!IMAGE_TYPES.has(asset?.mimeType) || typeof asset.data !== 'string' || !asset.data.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.data) || asset.data.length % 4 !== 0) throw new BridgeError('invalid_image', `The client did not return a supported embedded image. ${reread}`);
  return { type: 'image', mimeType: asset.mimeType, data: asset.data };
}

/**
 * Successful result: credential-like keys are dropped and every `message` /
 * `messageDetail` string is scrubbed of paths and explicit credentials; content
 * fields (prompts, notes, wiki text) are left as they are.
 */
export function success(result, images = [], roots) {
  const safe = sanitize(scrubMessages(result, roots));
  return { content: [{ type: 'text', text: JSON.stringify(safe) }, ...images], structuredContent: safe };
}

/** Coded errors raised by our own modules (not by the host); their message is explanatory. */
const isCodedOwnError = error => (error instanceof AssetSummaryError || error instanceof QueueControlError)
  && typeof error.code === 'string' && DOMAIN_CODE.test(error.code);

/**
 * One error fact for every tool. BridgeError keeps its code; its message and
 * details are scrubbed (identity fields the call itself supplied, or in their
 * expected format, pass unchanged). HostCallError and anything unrecognized are
 * opaque. 'core-messages' (material library, studies, tag details) additionally
 * keeps the explanations of recognized core rejections and maps filesystem errors.
 */
export function failure(error, { roots, trusted = {}, policy = 'opaque', layer = 'canvas' } = {}) {
  const internal = { code: 'internal_error', message: INTERNAL_MESSAGES[layer] ?? INTERNAL_MESSAGES.canvas };
  if (error instanceof BridgeError) return { code: error.code, message: scrubText(error.message, roots), ...(error.details !== undefined ? { details: scrubDeep(error.details, roots, trusted) } : {}) };
  if (error instanceof HostMethodNotAllowedError) return { code: error.code, message: 'A host method outside this tool\'s fixed list was refused before it was sent.' };
  // Work of a tool call that lost its call context (for example a listener registered outside it): a server defect.
  if (error instanceof HostCallOutsideToolError) return { code: error.code, message: 'A host call made outside a tool call was refused; nothing was sent. This is a server defect, not an argument problem: do not retry; read current state before continuing.' };
  if (error instanceof HostCallError || !(error instanceof Error)) return internal;
  if (error instanceof ContractValidationError) return { code: 'invalid_arguments', message: scrubText(error.message, roots) };
  if (isCodedOwnError(error)) return { code: error.code, message: scrubText(error.message, roots) };
  if (policy !== 'core-messages') return internal;
  if (error.name === 'AbortError') return { code: 'aborted', message: 'The request was cancelled. If it may have reached the host, read current state before any further write.' };
  if (typeof error.syscall === 'string' || (typeof error.code === 'string' && NODE_SYSTEM_CODE.test(error.code))) return { code: 'file_unavailable', message: FILE_UNAVAILABLE };
  if (error instanceof SyntaxError) return { code: 'invalid_input', message: 'The inbox file is not valid JSON.' };
  if (typeof error.code === 'string' && DOMAIN_CODE.test(error.code)) return { code: error.code, message: scrubText(error.message, roots) };
  if (Object.getPrototypeOf(error) === Error.prototype && error.code === undefined) return { code: 'request_rejected', message: scrubText(error.message, roots) };
  return internal;
}

export function errorResult(error) {
  const safe = sanitize(error);
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: safe }) }], structuredContent: { error: safe } };
}

// wholeInputSchema: the arguments the module behind a tool takes beyond the public ones; only a server built with the
// test option wholeResults validates against it. tools/list always shows inputSchema.
const ENTRY_KEYS = new Set(['name', 'layer', 'description', 'inputSchema', 'wholeInputSchema', 'annotations', 'hostMethods', 'errors', 'precheck', 'validate', 'handle']);
/** Checks and freezes the registry; names are unique and every entry is complete. */
export function defineRegistry(entries) {
  const seen = new Set();
  for (const entry of entries) {
    const extra = Object.keys(entry).filter(key => !ENTRY_KEYS.has(key));
    if (extra.length) throw new TypeError(`Tool ${entry.name} has unknown registry keys: ${extra.join(', ')}`);
    if (typeof entry.name !== 'string' || seen.has(entry.name)) throw new TypeError(`Duplicate or invalid tool name: ${entry.name}`);
    if (!LAYERS.includes(entry.layer) || !ERROR_POLICIES.includes(entry.errors) || typeof entry.description !== 'string' || entry.inputSchema?.type !== 'object' || typeof entry.handle !== 'function'
      || !Array.isArray(entry.hostMethods) || entry.hostMethods.some(method => typeof method !== 'string')) throw new TypeError(`Incomplete registry entry: ${entry.name}`);
    seen.add(entry.name);
  }
  return Object.freeze(entries.map(entry => Object.freeze({ ...entry, hostMethods: Object.freeze([...entry.hostMethods]) })));
}

export const publicTool = ({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations });

/**
 * A successful result whose paths are project-relative (pathBase:'project-root') also names that project root:
 * projectRoot is 'NOVELAI_PROJECT_ROOT' or 'data-dir-workspace' (<data root>/workspace), never an absolute path.
 */
function withProjectRootSource(result, source) {
  const value = result?.structuredContent;
  if (typeof source !== 'string' || result?.isError || !value || typeof value !== 'object' || Array.isArray(value) || value.pathBase !== 'project-root') return result;
  const safe = { ...value, projectRoot: source };
  return { ...result, content: [{ type: 'text', text: JSON.stringify(safe) }, ...result.content.slice(1)], structuredContent: safe };
}

/**
 * One MCP server over a subset of the registry. `exposed` lists the tool names in
 * tools/list order.
 * `context` is shared by all calls; ctx.signal is per call.
 */
export function createRegistryServer({ serverInfo, instructions, registry, exposed, context }) {
  const byName = new Map(registry.map(entry => [entry.name, entry]));
  const tools = exposed.map(name => { const entry = byName.get(name); if (!entry) throw new TypeError(`Unknown tool ${name}`); return entry; });
  const active = new Map(tools.map(entry => [entry.name, entry]));
  const listed = tools.map(publicTool);
  const server = new Server(serverInfo, { capabilities: { tools: {} }, instructions });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    const tool = typeof name === 'string' ? active.get(name) : undefined;
    // The client that called (its initialize clientInfo name/version, bounded) and one id per tool call go with every
    // host call of this tool call, so the host can show which agent called which tool and when (never the arguments).
    const scope = { tool: tool?.name, allowed: new Set(tool?.hostMethods ?? []), denied: [], client: callerClient(server.getClientVersion()), callId: randomUUID() };
    try {
      if (!tool) throw new BridgeError('unknown_tool', UNKNOWN_TOOL);
      tool.precheck?.(args);
      validateArguments(args, context?.wholeResults && tool.wholeInputSchema ? tool.wholeInputSchema : tool.inputSchema);
      tool.validate?.(args);
      const result = await hostCallScope.run(scope, () => tool.handle(args, { ...context, signal: extra.signal }));
      return scope.denied.length ? errorResult(hostMethodNotAllowed(tool.name, scope.denied)) : withProjectRootSource(result, context.projectRootSource);
    } catch (error) {
      // A refused host method decides the outcome even if a module turned the refusal into another error.
      if (scope.denied.length) return errorResult(hostMethodNotAllowed(tool.name, scope.denied));
      return errorResult(failure(error, { roots: context.roots, trusted: trustedIdentities(args), policy: tool?.errors ?? 'opaque', layer: tool?.layer ?? 'core' }));
    }
  });
  return server;
}
