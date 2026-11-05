import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Step 4c2: the old tab bar, menu bar and workspace actions were deleted with their tests; what stays is that the app
// mounts the new frame and the canvas's draft review, and none of the old shell.
describe('the app shell', () => {
  it('mounts the draft review with the canvas page of the new frame; no old shell (steps 4b1, 4b3, 4c2)', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    // Step 4b3: the old pending-changes dialog is replaced by the canvas's draft banner and review (src/canvas/
    // DraftReview.tsx), mounted with the canvas page, which the frame keeps mounted from the start.
    expect(source).not.toMatch(/<WorkspaceChanges\s*\/>/);
    const page = readFileSync(new URL('../canvas/CanvasPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('<Stage inpaintStage={inpaintStage} overlay={<DraftLayer />} />');
    expect(source).toContain('<AppShell');
    expect(source).toContain('<WorkspaceBridge />');
    expect(source).not.toMatch(/<AppTabBar|<AppTitleBar|<AppMenuBar|<WorkspaceActions|<HistoryPanel|V5MigrationNotice|UpdateBanner\(/);
  });
});
