import { firstValueFrom } from 'rxjs';
/**
 * Tests for the MilkdownEditor component.
 *
 * Covers:
 * - Component creation
 * - Fallback mode activation
 * - Content input/output
 * - Raw textarea behavior
 * - Transaction handling: a dispatched edit reaches the document and is
 *   published as markdown, and the formatting state is republished after it
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { MilkdownEditor } from './milkdown-editor';
import { settle } from '@app/shared/testing/zoneless';
import { editorViewCtx } from '@milkdown/kit/core';

/**
 * The `EditorView` the component built, reached through the same context slice
 * the component itself uses (`milkdown-editor.ts`). Private on the component
 * because nothing outside it needs the view — this test needs it to dispatch the
 * edit a keystroke would have dispatched.
 *
 * Typed structurally, for the reason `milkdown-editor.ts:51-68` gives: the view
 * and its state are ProseMirror's, reachable only through Milkdown's transitive
 * types. Only the members these tests touch are declared.
 */
interface MountedView {
  dispatch: (tr: unknown) => void;
  state: {
    doc: { textContent: string };
    tr: {
      insertText: (text: string, from: number, to: number) => unknown;
      addStoredMark: (mark: unknown) => unknown;
    };
    schema: { marks: Record<string, { create: () => unknown } | undefined> };
  };
}

async function mountedView(component: unknown): Promise<MountedView> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bundle = (component as any).editorInstance;

  expect(bundle, 'the editor never finished initializing').toBeTruthy();

  return bundle.action((ctx: { get: (slice: unknown) => unknown }) => ctx.get(editorViewCtx)) as MountedView;
}

describe('MilkdownEditor', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let component: any;

  async function setup(content = '') {
    TestBed.configureTestingModule({
      imports: [TranslocoTestingModule.forRoot({ preloadLangs: true, langs: { en: {} } })],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));

    const fixture = TestBed.createComponent(MilkdownEditor);

    fixture.componentRef.setInput('content', content);
    component = fixture.componentInstance;
    await settle(fixture);
  }

  it('should be created', async () => {
    await setup();
    expect(component).toBeTruthy();
  });

  it('should reach ready or fallback state after initialization', async () => {
    // afterNextRender + the lazy Milkdown import settle asynchronously, so poll
    // for either terminal state. Which one is reached is the environment's
    // business — the two behavioural tests below require `editorReady`, and skip
    // loudly if this environment ever stops mounting the editor.
    await setup('Hello world');

    for (let i = 0; i < 200 && !component.editorReady() && !component.fallbackMode(); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(component.fallbackMode() || component.editorReady()).toBe(true);
  });

  it('applies a dispatched edit to the document and publishes it as markdown', async () => {
    // THE REGRESSION THIS SPEC EXISTS FOR. The component used to observe
    // transactions by overriding `view.props.dispatchTransaction` and calling the
    // captured value. ProseMirror's default ("apply the transaction") is a branch
    // inside `EditorView.prototype.dispatch`, not a prop, so the captured value was
    // `undefined` and the override silently discarded every transaction. Typing
    // did nothing, Milkdown's `markdownUpdated` never fired, `contentChange` never
    // emitted, and every form that gates its submit button on the emitted value
    // stayed disabled — which is how `e2e/comment.spec.ts` failed.
    await setup('');

    for (let i = 0; i < 200 && !component.editorReady() && !component.fallbackMode(); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    if (!component.editorReady()) {
      // Fallback mode means the environment did not mount Milkdown, so there is
      // no view to dispatch into. Say so rather than passing vacuously.
      throw new Error('Milkdown did not mount in this environment; this test cannot observe transactions');
    }

    const emitted: string[] = [];

    component.contentChange.subscribe((v: string) => emitted.push(v));

    const view = await mountedView(component);

    // Position 1 is inside the editor's one empty paragraph — the document
    // ProseMirror builds for an empty value.
    view.dispatch(view.state.tr.insertText('Hello', 1, 1));

    // Two separate assertions, because they fail for different reasons: the first
    // is the transaction being applied at all, the second is the markdown reaching
    // the consumer. Milkdown debounces `markdownUpdated` by 200 ms
    // (`@milkdown/plugin-listener`), so poll rather than sleep a fixed amount.
    expect(view.state.doc.textContent).toBe('Hello');

    for (let i = 0; i < 100 && emitted.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(emitted.join('')).toContain('Hello');
  });

  it('republishes the formatting state of the selection after an edit', async () => {
    // The toggle behaviour, and the reason the transaction observation exists at all:
    // the four formatting toggles report `aria-pressed` from ProseMirror's own
    // state. It is asserted here through the PUBLIC surface (`isMarkActive`),
    // because an override that drops the transaction would also freeze this.
    await setup('');

    for (let i = 0; i < 200 && !component.editorReady() && !component.fallbackMode(); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    if (!component.editorReady()) {
      throw new Error('Milkdown did not mount in this environment; this test cannot observe transactions');
    }

    expect(component.isMarkActive('strong')).toBe(false);

    const view = await mountedView(component);

    view.dispatch(view.state.tr.addStoredMark(view.state.schema.marks['strong']?.create()));

    expect(component.isMarkActive('strong')).toBe(true);
  });

  it('should set fallbackContent from input', async () => {
    await setup('# Test');
    expect(component.fallbackContent()).toBe('# Test');
  });

  it('should emit contentChange on raw textarea input', async () => {
    await setup('');

    const emitted: string[] = [];

    component.contentChange.subscribe((v: string) => emitted.push(v));

    const event = { target: { value: 'new content' } } as unknown as Event;

    component.onRawInput(event);
    expect(emitted).toEqual(['new content']);
    expect(component.fallbackContent()).toBe('new content');
  });

  it('should handle empty content gracefully', async () => {
    await setup();
    expect(component.fallbackContent()).toBe('');
  });
});
