/** Global listeners outlive hidden canvases. DOM inert alone cannot guard them. canvasShown: the canvas page of the
 * new frame is the visible page (step 4b1: the library and queue pages keep the canvas mounted but hidden). */
export function canHandleInpaintKeyboard(context: { activeTab: string; modalOpen: boolean; canvasShown?: boolean; defaultPrevented?: boolean; isComposing?: boolean }) {
  return context.activeTab === 'inpaint' && context.canvasShown !== false && !context.modalOpen && !context.defaultPrevented && !context.isComposing;
}
