import { Seg } from '../ui';
import { useUiText } from '../ui/i18n';
import { useAppStore } from '../store';
import { creativeMode, selectCreativeMode, useWorkbenchNavigation, type CreativeMode } from '../app/workbench-navigation';

type Top = 't2i' | 'i2i' | 'inpaint' | 'post';
type Post = 'enhance' | 'upscale' | 'director';
const POST: readonly CreativeMode[] = ['enhance', 'upscale', 'director'];

/** The mode the canvas shows: the store's page and sub-mode (auxiliary pages fall back to the last creative mode). */
export function useCanvasMode(): CreativeMode {
  const activeTab = useAppStore(state => state.activeTab);
  const generateMode = useAppStore(state => state.generateMode);
  const postprocessMode = useAppStore(state => state.postprocessMode);
  const lastCreative = useWorkbenchNavigation(state => state.lastCreative);
  return creativeMode({ activeTab, generateMode, postprocessMode }) ?? lastCreative;
}
export const isPostMode = (mode: CreativeMode) => POST.includes(mode);

/**
 * The mode switch at the top of the left column (prototype 13–16; it replaces the 4b1 CanvasModeBar): 文生图 / 图生图 /
 * 局部重绘 / 后期, and under 后期 增强 / 放大 / Director. Selecting goes through selectCreativeMode, as before.
 */
export function ModeSwitch() {
  const { t } = useUiText();
  const mode = useCanvasMode();
  const post = isPostMode(mode);
  const top: Top = post ? 'post' : mode as Top;
  return <div className="cv-modes" data-testid="canvas-mode-switch">
    <Seg<Top> full label={t('cv.mode.label')} value={top} onChange={value => selectCreativeMode(value === 'post' ? (post ? mode : 'upscale') : value)} options={[
      { value: 't2i', label: t('cv.mode.t2i') }, { value: 'i2i', label: t('cv.mode.i2i') }, { value: 'inpaint', label: t('cv.mode.inpaint') }, { value: 'post', label: t('cv.mode.post') },
    ]} />
    {post && <Seg<Post> full size="sm" label={t('cv.post.label')} value={mode as Post} onChange={value => selectCreativeMode(value)} options={[
      { value: 'enhance', label: t('cv.post.enhance') }, { value: 'upscale', label: t('cv.post.upscale') }, { value: 'director', label: t('cv.post.director') },
    ]} />}
  </div>;
}
