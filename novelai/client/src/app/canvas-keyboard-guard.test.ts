import { describe, expect, it } from 'vitest';
import { canHandleInpaintKeyboard } from './canvas-keyboard-guard';
import { readFileSync } from 'node:fs';
const active = { activeTab: 'inpaint', modalOpen: false };
describe('hidden canvas keyboard guard', () => {
  it('permits only the active unobstructed inpaint canvas', () => {
    expect(canHandleInpaintKeyboard(active)).toBe(true);
    for (const patch of [{activeTab:'generate'},{activeTab:'tools'},{modalOpen:true},{canvasShown:false},{defaultPrevented:true},{isComposing:true}]) expect(canHandleInpaintKeyboard({...active,...patch})).toBe(false);
  });
  it('guards before Space, undo, redo and brush shortcuts in the real global listener', () => {
    const source=readFileSync(new URL('../InpaintCanvas.tsx',import.meta.url),'utf8');
    const listener=source.slice(source.indexOf('const keyDown = (event: KeyboardEvent) => {'));
    expect(listener.indexOf('canHandleInpaintKeyboard')).toBeLessThan(listener.indexOf('event.code === "Space"'));
    expect(listener).toContain('modalOpen: !!document.querySelector');
    // Step 4b1: the library and queue pages keep the canvas mounted but hidden; its shortcuts stay off there.
    expect(listener).toContain("canvasShown: useShellRoute.getState().page === 'canvas'");
  });
});
