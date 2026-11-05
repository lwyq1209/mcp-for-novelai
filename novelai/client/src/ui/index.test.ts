import { describe, expect, it } from 'vitest';
import * as ui from './index';

describe('ui index', () => {
  it('exports every component and pure helper', () => {
    for (const name of [
      'Icon', 'BrandMark', 'ICON_NAMES', 'UiPortal', 'Button', 'IconButton', 'Seg', 'segNextValue', 'Chip', 'Tag', 'Dot', 'Toggle', 'Checkbox',
      'Field', 'TextInput', 'TextArea', 'SearchInput', 'Menu', 'MenuButton', 'menuPosition', 'nextEnabledIndex', 'Dialog', 'ConfirmDialog',
      'trapFocusIndex', 'Drawer', 'ToastHost', 'showToast', 'dismissToast', 'useToasts', 'EmptyState', 'Tabs', 'Progress', 'Spinner', 'Tooltip',
      'Kbd', 'Disclosure',
    ]) {
      expect(ui, name).toHaveProperty(name);
    }
  });
});
