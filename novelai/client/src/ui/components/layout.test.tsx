import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Field, SearchInput, TextArea, TextInput } from './Field';
import { Drawer } from './Drawer';
import { EmptyState } from './EmptyState';
import { Tabs, tabIds } from './Tabs';
import { Disclosure } from './Disclosure';

const noop = () => {};

describe('Field', () => {
  it('labels the control and links hint and error', () => {
    const out = renderToStaticMarkup(
      <Field label="Seed" hint="Empty = random" error="Must be a number" htmlFor="seed">
        <TextInput />
      </Field>,
    );
    expect(out).toContain('<label class="ui-field__label" for="seed">Seed</label>');
    expect(out).toContain('id="seed"');
    expect(out).toContain('aria-describedby="seed-hint seed-error"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('<div class="ui-field__hint" id="seed-hint">Empty = random</div>');
    expect(out).toContain('class="ui-field__error" id="seed-error"');
  });
  it('generates an id when none is given and keeps a child id', () => {
    const generated = renderToStaticMarkup(<Field label="Name"><TextInput /></Field>);
    const id = generated.match(/for="([^"]+)"/)?.[1];
    expect(id).toMatch(/^ui-field-/);
    expect(generated).toContain(`id="${id}"`);
    expect(generated).not.toContain('aria-describedby');
    const own = renderToStaticMarkup(<Field label="Name"><TextInput id="mine" /></Field>);
    expect(own).toContain('for="mine"');
  });
  it('TextInput and TextArea mark invalid state', () => {
    expect(renderToStaticMarkup(<TextInput invalid placeholder="p" />)).toBe('<input aria-invalid="true" placeholder="p" type="text" class="ui-input ui-input--invalid"/>');
    expect(renderToStaticMarkup(<TextInput />)).toBe('<input type="text" class="ui-input"/>');
    const area = renderToStaticMarkup(<TextArea rows={4} invalid />);
    expect(area).toContain('class="ui-input ui-textarea ui-input--invalid"');
    expect(area).toContain('rows="4"');
  });
});

describe('SearchInput', () => {
  it('shows the shortcut while empty', () => {
    const out = renderToStaticMarkup(<SearchInput value="" onChange={noop} placeholder="Search prompts" label="Search" shortcut="⌘K" clearLabel="Clear" />);
    expect(out).toContain('role="searchbox"');
    expect(out).toContain('aria-label="Search"');
    expect(out).toContain('placeholder="Search prompts"');
    expect(out).toContain('<kbd class="ui-kbd ui-search__kbd">⌘K</kbd>');
    expect(out).not.toContain('ui-search__clear');
    expect(out).toContain('ui-search__icon');
  });
  it('shows the clear button with a value', () => {
    const out = renderToStaticMarkup(<SearchInput value="girl" onChange={noop} placeholder="p" label="Search" shortcut="⌘K" clearLabel="Clear search" />);
    expect(out).toContain('value="girl"');
    expect(out).toContain('class="ui-search__clear" aria-label="Clear search" title="Clear search"');
    expect(out).not.toContain('ui-kbd');
  });
});

describe('Drawer', () => {
  it('renders an in-page aside with header, actions, body and footer', () => {
    const out = renderToStaticMarkup(
      <Drawer title="image_0001.png" onClose={noop} closeLabel="Close details" actions={<button type="button">A</button>} footer={<span>F</span>}>
        <p>Body</p>
      </Drawer>,
    );
    expect(out).toContain('<aside tabindex="-1" class="ui-drawer" style="width:420px" aria-label="image_0001.png">');
    expect(out).toContain('<h2 class="ui-drawer__title">image_0001.png</h2><button type="button">A</button>');
    expect(out).toContain('aria-label="Close details"');
    expect(out).toContain('<div class="ui-drawer__body"><p>Body</p></div>');
    expect(out).toContain('<div class="ui-drawer__foot"><span>F</span></div>');
    const custom = renderToStaticMarkup(<Drawer title={<b>x</b>} label="Details" width={360} onClose={noop} closeLabel="Close">b</Drawer>);
    expect(custom).toContain('style="width:360px" aria-label="Details"');
    expect(custom).not.toContain('ui-drawer__foot');
  });
});

describe('EmptyState', () => {
  it('renders icon, title, body and action', () => {
    const out = renderToStaticMarkup(<EmptyState icon="image" title="No images yet" body="Generated images appear here." action={<button type="button">Go</button>} />);
    expect(out).toContain('class="ui-empty"');
    expect(out).toContain('<div class="ui-empty__icon" aria-hidden="true">');
    expect(out).toContain('<h4 class="ui-empty__title">No images yet</h4>');
    expect(out).toContain('<p class="ui-empty__body">Generated images appear here.</p>');
    expect(out).toContain('<div class="ui-empty__action"><button type="button">Go</button></div>');
    expect(renderToStaticMarkup(<EmptyState icon="image" title="t" />)).not.toContain('ui-empty__body');
  });
});

describe('Tabs', () => {
  it('renders a tablist with one selected tab and roving tabindex', () => {
    const out = renderToStaticMarkup(
      <Tabs value="params" tabs={[{ value: 'prompt', label: 'Prompt' }, { value: 'params', label: 'Parameters' }]} onChange={noop} label="Details" idBase="dt" />,
    );
    expect(out).toContain('role="tablist" aria-label="Details"');
    expect(out.match(/role="tab"/g)).toHaveLength(2);
    expect(out).toContain('id="dt-tab-params" aria-controls="dt-panel-params" aria-selected="true" tabindex="0" class="ui-tabs__tab ui-tabs__tab--on"');
    expect(out).toContain('aria-selected="false" tabindex="-1" class="ui-tabs__tab"');
    expect(tabIds('dt', 'prompt')).toEqual({ tab: 'dt-tab-prompt', panel: 'dt-panel-prompt' });
  });
});

describe('Disclosure', () => {
  it('links the button to its region and hides it when closed', () => {
    const closed = renderToStaticMarkup(<Disclosure summary="Technical details">body</Disclosure>);
    const controls = closed.match(/aria-controls="([^"]+)"/)?.[1];
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain(`id="${controls}" class="ui-disclosure__body" hidden=""`);
    expect(closed).toContain('class="ui-disclosure"');
    const open = renderToStaticMarkup(<Disclosure summary="s" defaultOpen className="x">body</Disclosure>);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('class="ui-disclosure ui-disclosure--open x"');
    expect(open).not.toContain('hidden=""');
  });
});
