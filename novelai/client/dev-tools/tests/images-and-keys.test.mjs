import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeyCombo, parseTarget, stripWindowErrorSuffix, stripWindowErrorSuffixes } from '../lib/cdp.mjs';
import { imageSize, placeholderPng, unzip, zipStored } from '../lib/images.mjs';
import { clientRequire } from '../lib/paths.mjs';

const sharp = clientRequire('sharp');
const JSZip = clientRequire('jszip');

test('placeholder PNGs decode at exactly the requested size and carry their text chunks', async () => {
  for (const [width, height] of [[1, 1], [64, 96], [832, 1216]]) {
    const png = placeholderPng(width, height, { seed: 42, text: { Comment: '{"fake":true}' } });
    const meta = await sharp(png).metadata();
    assert.deepEqual([meta.width, meta.height, meta.format], [width, height, 'png']);
    assert.deepEqual(imageSize(png), { type: 'png', width, height });
    assert.ok(png.includes(Buffer.from('Comment\0{"fake":true}')));
  }
  assert.notDeepEqual(placeholderPng(16, 16, { seed: 1 }), placeholderPng(16, 16, { seed: 2 }), 'different seeds look different');
  assert.throws(() => placeholderPng(0, 10));
});

test('imageSize reads JPEG and WebP headers too', async () => {
  const png = placeholderPng(40, 24);
  assert.deepEqual(imageSize(await sharp(png).jpeg().toBuffer()), { type: 'jpeg', width: 40, height: 24 });
  assert.deepEqual(imageSize(await sharp(png).webp().toBuffer()), { type: 'webp', width: 40, height: 24 });
  assert.deepEqual(imageSize(await sharp(png).webp({ lossless: true }).toBuffer()), { type: 'webp', width: 40, height: 24 });
  assert.equal(imageSize(Buffer.from('nope, not an image at all')), null);
});

test('stored ZIPs open in JSZip (the client\'s reader) and in unzip()', async () => {
  const entries = [{ name: 'image_0.png', data: placeholderPng(8, 8) }, { name: 'image_1.png', data: placeholderPng(9, 9) }];
  const archive = zipStored(entries);
  const zip = await JSZip.loadAsync(archive);
  assert.deepEqual(Object.keys(zip.files), ['image_0.png', 'image_1.png']);
  assert.deepEqual(await zip.files['image_1.png'].async('nodebuffer'), entries[1].data);
  assert.deepEqual(unzip(archive).map(entry => entry.name), ['image_0.png', 'image_1.png']);
  assert.deepEqual(Object.keys((await JSZip.loadAsync(zipStored([]))).files), []);
});

test('key combos map to real key events (macOS editing commands named)', () => {
  assert.deepEqual(parseKeyCombo('Enter', 'darwin'), { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', modifiers: 0 });
  assert.deepEqual(parseKeyCombo('Shift+Tab', 'linux'), { key: 'Tab', code: 'Tab', keyCode: 9, text: undefined, modifiers: 8 });
  assert.deepEqual(parseKeyCombo('Mod+a', 'darwin'), { key: 'a', code: 'KeyA', keyCode: 65, text: undefined, modifiers: 4, commands: ['selectAll'] });
  assert.deepEqual(parseKeyCombo('Mod+a', 'win32'), { key: 'a', code: 'KeyA', keyCode: 65, text: undefined, modifiers: 2 });
  assert.deepEqual(parseKeyCombo('Shift+a', 'darwin'), { key: 'A', code: 'KeyA', keyCode: 65, text: 'A', modifiers: 8 });
  assert.equal(parseKeyCombo('Space').key, ' ');
  assert.equal(parseKeyCombo('7').code, 'Digit7');
  assert.throws(() => parseKeyCombo('Hyper+a'));
  assert.throws(() => parseKeyCombo('NoSuchKey'));
});

test('targets: CSS by default, text= exact, text^= contains', () => {
  assert.deepEqual(parseTarget('.a > b'), { css: '.a > b' });
  assert.deepEqual(parseTarget('text=取消'), { text: '取消', exact: true });
  assert.deepEqual(parseTarget('text^=删除 2', { nth: 1 }), { text: '删除 2', exact: false, nth: 1 });
  assert.throws(() => parseTarget(''));
});

test('window texts lose the invisible host error suffix before they are printed (eval errors and values)', () => {
  const suffix = '\u2063\u2064\u2063\u200b\u200c\u200d\u2060\u200b';
  assert.equal(stripWindowErrorSuffix(`Error: The token was refused.${suffix}\n    at x (index.js:1:2)`), 'Error: The token was refused.\n    at x (index.js:1:2)');
  assert.equal(stripWindowErrorSuffix('plain text'), 'plain text');
  assert.equal(stripWindowErrorSuffix(42), 42);
  assert.deepEqual(stripWindowErrorSuffixes({ error: `bad${suffix}`, list: [`a${suffix}`, 1, null], nested: { ok: true } }), { error: 'bad', list: ['a', 1, null], nested: { ok: true } });
});
