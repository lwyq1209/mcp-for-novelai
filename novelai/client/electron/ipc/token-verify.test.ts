/**
 * Step 4c1: the token check answers in English with a reason the window renders in its language (the Chinese texts
 * that reached an English window are gone). The account route is the real verifyToken with axios answering as
 * NovelAI would (401, a Cloudflare 502 page, an HTML error page, a JSON message, a dropped connection).
 */
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', isPackaged: false, getVersion: () => '0.1.0' }, dialog: {}, nativeImage: {} }));
vi.mock('./store', () => ({
  addHistory: vi.fn(), getAccountSummary: () => ({}), getHistoryGroups: () => [], getToken: () => null,
  getSettings: () => ({ imageBaseUrl: 'https://image.novelai.net', apiBaseUrl: 'https://api.novelai.net', proxyMode: 'direct' }),
  setToken: vi.fn(), setAccountSummary: vi.fn(),
}));
import { verifyToken } from './nai';
import { hostMessageText } from '../../src/host-errors/compose';

afterEach(() => vi.restoreAllMocks());
const cjk = /[\u4e00-\u9fff]/;
const reject = (status: number | undefined, data: unknown) => vi.spyOn(axios, 'get').mockRejectedValue(Object.assign(new Error(status ? `Request failed with status code ${status}` : 'connect ECONNREFUSED 127.0.0.1:9'), status ? { response: { status, data } } : {}));

describe('verifyToken answers (step 4c1)', () => {
  it.each([
    ['an empty token', undefined, null, 'token.empty', '请输入 NovelAI Persistent API Token。'],
    ['HTTP 401', 401, { statusCode: 401, message: 'Unauthorized' }, 'token.invalid', 'Token 无效或已过期。'],
    ['a Cloudflare 502 page', 502, '<!doctype html><html><body>Bad gateway Error code 502</body></html>', 'remote.unavailable', 'NovelAI 暂时不可用（HTTP 502 Bad Gateway），请稍后重试。'],
    ['an HTML error page', 500, '<html><body><h1>Oops</h1></body></html>', 'remote.html_page', 'NovelAI 返回了网页错误，请稍后重试。'],
    ['a JSON message', 400, { statusCode: 400, message: 'update to the image URL' }, 'token.verify_failed', 'update to the image URL'],
    ['a dropped connection', undefined, undefined, 'token.verify_failed', 'connect ECONNREFUSED 127.0.0.1:9'],
  ] as const)('%s', async (label, status, data, reason, zh) => {
    if (label !== 'an empty token') reject(status, data);
    const result = await verifyToken(label === 'an empty token' ? '  ' : 'pst-fake');
    expect(result).toMatchObject({ valid: false, reason });
    expect(result.message).not.toMatch(cjk);
    expect(hostMessageText(result, 'zh-CN')).toBe(zh);
    expect(hostMessageText(result, 'en-US')).not.toMatch(cjk);
  });
});
