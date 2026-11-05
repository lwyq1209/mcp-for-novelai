import { create } from 'zustand';
import { useAppStore } from '../store';

export type CreativeMode = 't2i' | 'i2i' | 'inpaint' | 'enhance' | 'upscale' | 'director';
type Location = Pick<ReturnType<typeof useAppStore.getState>, 'activeTab' | 'generateMode' | 'postprocessMode'>;
export function creativeMode(location: Location): CreativeMode | null {
  if (location.activeTab === 'generate') return location.generateMode;
  if (location.activeTab === 'inpaint') return 'inpaint';
  if (location.activeTab === 'postprocess') return location.postprocessMode;
  return null;
}
export const useWorkbenchNavigation = create<{ lastCreative: CreativeMode }>(() => ({ lastCreative: 't2i' }));
export function selectCreativeMode(mode: CreativeMode) {
  const store = useAppStore.getState();
  if (mode === 'inpaint') store.setActiveTab('inpaint');
  else if (mode === 't2i' || mode === 'i2i' || mode === 'enhance') { store.setGenerateMode(mode); store.setActiveTab('generate'); }
  else { store.setPostprocessMode(mode); store.setActiveTab('postprocess'); }
  useWorkbenchNavigation.setState({ lastCreative: mode });
}
