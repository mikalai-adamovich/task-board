import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewEncapsulation,
  effect,
  inject,
  input,
  output,
  signal,
  afterNextRender,
  PLATFORM_ID,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBold,
  lucideItalic,
  lucideStrikethrough,
  lucideCode,
  lucideLink,
  lucideList,
  lucideListOrdered,
  lucideListChecks,
  lucideQuote,
  lucideMinus,
  lucideHeading,
  lucideEye,
  lucideFileText,
} from '@ng-icons/lucide';
import { HlmSpinnerImports } from '@spartan-ng/helm/spinner';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';
import { injectToasts } from '@app/shared/utils/toast-utils';
import { getErrorMessage } from '@app/shared/utils/error-utils';

/**
 * Milkdown schema ids of the four formatting toggles — read from the presets
 * themselves (`strongSchema`, `emphasisSchema`, `inlineCodeSchema`,
 * `strikethroughSchema` are `"strong" | "emphasis" | "inlineCode" |
 * "strike_through"`), not from the toolbar's command names, which differ.
 */
const TOGGLE_MARKS = ['strong', 'emphasis', 'strike_through', 'inlineCode'] as const;

type ToggleMark = (typeof TOGGLE_MARKS)[number];

/**
 * The slice of ProseMirror's `EditorState` this component reads. Declared
 * structurally on purpose: `prosemirror-state` / `prosemirror-view` are Milkdown's
 * transitive dependencies, not ours, so importing their types would mean adding a
 * dependency this package does not declare. Method syntax keeps the real
 * (stricter) signatures assignable.
 */
interface MarkState {
  selection: {
    from: number;
    to: number;
    empty: boolean;
    $from: { marks(): readonly { type: { name: string } }[] };
  };
  storedMarks: readonly { type: { name: string } }[] | null;
  doc: { rangeHasMark(from: number, to: number, markType: object): boolean };
  schema: { marks: Readonly<Record<string, { name: string } | undefined>> };
}

/** Commands invocable from the toolbar */
type ToolbarCommand =
  | 'strong'
  | 'emphasis'
  | 'strikethrough'
  | 'inlineCode'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'codeBlock'
  | 'hr';

interface EditorBundle {
  action: (fn: unknown) => unknown;
  destroy: () => Promise<void>;
}

/** highlight.js grammars registered for code-block highlighting (order matches the imports in `initMilkdown`) */
const HIGHLIGHT_LANGUAGES = [
  'javascript',
  'typescript',
  'json',
  'bash',
  'python',
  'xml',
  'css',
  'sql',
  'yaml',
  'diff',
  'markdown',
  'plaintext',
] as const;

/**
 * Reusable WYSIWYG Markdown editor powered by Milkdown.
 *
 * - WYSIWYG mode: Milkdown (lazy-loaded) with a formatting toolbar.
 * - Raw mode: plain textarea showing the underlying markdown.
 * - Falls back to the textarea automatically if Milkdown fails to load.
 *
 * The value is always markdown (`contentChange` emits on every change),
 * so the backend keeps storing a plain markdown text field.
 */
@Component({
  selector: 'ui-milkdown-editor',
  imports: [TranslocoPipe, NgIcon, HlmSpinnerImports, HlmTextareaImports, HlmButtonImports, HlmTooltipImports],
  providers: [
    provideIcons({
      lucideBold,
      lucideItalic,
      lucideStrikethrough,
      lucideCode,
      lucideLink,
      lucideList,
      lucideListOrdered,
      lucideListChecks,
      lucideQuote,
      lucideMinus,
      lucideHeading,
      lucideEye,
      lucideFileText,
    }),
  ],
  templateUrl: './milkdown-editor.html',
  styleUrl: './milkdown-editor.css',
  encapsulation: ViewEncapsulation.None,
})
export class MilkdownEditor implements OnInit, OnDestroy {
  private readonly elRef = inject(ElementRef<HTMLElement>);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly notify = injectToasts();
  private readonly transloco = inject(TranslocoService);
  /** Markdown content input */
  readonly content = input<string>('');
  /** Whether the editor is read-only (hides toolbar, disables editing) */
  readonly readOnly = input<boolean>(false);
  /** Emits updated markdown whenever the editor content changes */
  readonly contentChange = output<string>();
  /** Emits `true` once the editor (or its fallback) is ready to be shown */
  readonly readyChange = output<boolean>();
  private readonly editorReady = signal(false);
  private readonly fallbackMode = signal(false);
  private readonly fallbackContent = signal('');
  /** `'wysiwyg'` (Milkdown) or `'raw'` (markdown textarea) */
  private readonly mode = signal<'wysiwyg' | 'raw'>('wysiwyg');
  private editorInstance: EditorBundle | null = null;
  private callCommandFn: ((key: unknown, payload?: unknown) => unknown) | null = null;
  private commands: Record<string, { key: unknown }> = {};
  /** Lazily-loaded `replaceAll` macro for in-place content updates */
  private replaceAllFn: ((markdown: string, flush?: boolean) => unknown) | null = null;
  /** Bumped on every teardown — invalidates any in-flight async initialization */
  private initEpoch = 0;
  /** Latest markdown emitted by the editor (may differ from input due to cleanup) */
  private lastMarkdown = '';
  /** Flag to suppress the content-change effect when the editor itself is the source */
  private suppressContentEffect = false;
  // ─── a11y: the formatting toggles' state ────────────────────────────────────
  /**
   * Which of the four formatting marks are active on the current selection.
   * A toggle that cannot report its state is a toggle a screen-reader user has
   * to guess at, so this is read from ProseMirror rather than assumed.
   */
  private readonly activeMarks = signal<Record<ToggleMark, boolean>>({
    strong: false,
    emphasis: false,
    strike_through: false,
    inlineCode: false,
  });

  /** `aria-pressed` source for the four formatting toggles. */
  protected isMarkActive(mark: ToggleMark): boolean {
    return this.activeMarks()[mark] ?? false;
  }

  /** Recompute the toggles' state from the editor's own selection. */
  private syncActiveMarks(state: MarkState): void {
    const { from, to, empty } = state.selection;
    const isActive = (name: ToggleMark): boolean => {
      const type = state.schema.marks[name];

      if (!type) return false;
      // A collapsed selection carries no range, so the marks that would be
      // applied next live in `storedMarks` (or the marks at the cursor).
      if (empty) {
        const stored = state.storedMarks ?? state.selection.$from.marks();

        return stored.some((mark) => mark.type.name === name);
      }

      return state.doc.rangeHasMark(from, to, type);
    };
    const next: Record<ToggleMark, boolean> = {
      strong: isActive('strong'),
      emphasis: isActive('emphasis'),
      strike_through: isActive('strike_through'),
      inlineCode: isActive('inlineCode'),
    };
    const current = this.activeMarks();

    if (TOGGLE_MARKS.every((mark) => current[mark] === next[mark])) return;

    this.activeMarks.set(next);
  }

  constructor() {
    // Watch for external content changes (e.g., after form submit clears the value)
    effect(() => {
      const newContent = this.content() ?? '';

      // Skip if the change came from the editor itself
      if (this.suppressContentEffect) {
        this.suppressContentEffect = false;
        return;
      }

      // Only apply if the editor is ready and content truly changed externally
      if (this.editorReady() && this.lastMarkdown !== newContent && this.replaceAllFn) {
        this.lastMarkdown = newContent;
        this.fallbackContent.set(newContent);
        // Update content in place via the `replaceAll` macro — no destroy/recreate
        this.editorInstance?.action(this.replaceAllFn(newContent));
      }
    });

    // Only initialize Milkdown in the browser (not SSR)
    afterNextRender(() => {
      if (isPlatformBrowser(this.platformId)) {
        const initial = this.content() ?? '';

        this.lastMarkdown = initial;
        void this.initMilkdown();
      }
    });
  }

  ngOnDestroy(): void {
    // Invalidate any in-flight initialization before tearing down
    this.initEpoch++;
    void this.editorInstance?.destroy();
    this.editorInstance = null;
  }

  /** Sync the raw-textarea value with the input on creation */
  ngOnInit(): void {
    this.fallbackContent.set(this.content() ?? '');
    this.lastMarkdown = this.content() ?? '';
  }

  // ─── Toolbar ───────────────────────────────────────────────────────────────

  protected runCommand(name: ToolbarCommand): void {
    const { editorInstance, callCommandFn, commands } = this;

    if (!editorInstance || !callCommandFn || !commands[name]) return;

    editorInstance.action(callCommandFn(commands[name].key));
  }

  protected runHeading(level: number): void {
    const { editorInstance, callCommandFn, commands } = this;

    if (!editorInstance || !callCommandFn || !commands['heading']) return;

    editorInstance.action(callCommandFn(commands['heading'].key, level));
  }

  /** Insert a link via prompt */
  protected insertLink(): void {
    const url = prompt('Enter URL:');

    if (!url) return;

    const { editorInstance, callCommandFn } = this;

    if (!editorInstance || !callCommandFn) return;

    const linkCmd = this.commands['link'];

    if (linkCmd) {
      editorInstance.action(callCommandFn(linkCmd.key, { href: url }));
    }
  }

  /** Toggle between WYSIWYG and raw markdown editing */
  protected toggleMode(): void {
    if (this.mode() === 'wysiwyg') {
      // Keep the current markdown before tearing the editor down
      this.fallbackContent.set(this.lastMarkdown);
      this.destroyEditor();
      this.mode.set('raw');
    } else {
      this.mode.set('wysiwyg');
      // Recreate the editor seeded with the raw markdown
      void this.initMilkdown(this.fallbackContent());
    }
  }

  // ─── Raw / fallback textarea ───────────────────────────────────────────────

  protected onRawInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;

    this.fallbackContent.set(value);
    this.lastMarkdown = value;
    this.suppressContentEffect = true;
    this.contentChange.emit(value);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private enterFallbackMode(): void {
    this.fallbackMode.set(true);
    // The textarea fallback is immediately usable — count it as ready
    this.readyChange.emit(true);
  }

  private destroyEditor(): void {
    // Invalidate any in-flight initialization before tearing down
    this.initEpoch++;
    void this.editorInstance?.destroy();
    this.editorInstance = null;
    this.editorReady.set(false);
  }

  private async initMilkdown(seed?: string): Promise<void> {
    // Snapshot the epoch — if the editor is torn down while modules load, bail out
    const epoch = this.initEpoch;
    const isStale = () => epoch !== this.initEpoch;

    try {
      const [
        { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, editorViewCtx, prosePluginsCtx },
        commonmarkPreset,
        gfmPreset,
        { listener, listenerCtx },
        { callCommand },
        { history },
        { highlight, highlightPluginConfig },
        { Plugin },
      ] = await Promise.all([
        import('@milkdown/kit/core'),
        import('@milkdown/kit/preset/commonmark'),
        import('@milkdown/kit/preset/gfm'),
        import('@milkdown/kit/plugin/listener'),
        import('@milkdown/kit/utils'),
        import('@milkdown/kit/plugin/history'),
        // Not part of @milkdown/kit — kept as a direct dependency
        import('@milkdown/plugin-highlight'),
        // A subpath of @milkdown/kit (it re-exports prosemirror-state), so this
        // still resolves through the one dependency the UI already declares.
        import('@milkdown/kit/prose/state'),
      ]);

      if (isStale()) return;

      // Lazy-load lowlight with a curated grammar set. The `common` preset bundles
      // all 37 highlight.js grammars (~900 kB raw); this dozen covers real usage
      // in task descriptions and comments at a fraction of the size.
      const [{ createLowlight }, ...grammarImports] = await Promise.all([
        import('lowlight'),
        import('highlight.js/lib/languages/javascript'),
        import('highlight.js/lib/languages/typescript'),
        import('highlight.js/lib/languages/json'),
        import('highlight.js/lib/languages/bash'),
        import('highlight.js/lib/languages/python'),
        import('highlight.js/lib/languages/xml'),
        import('highlight.js/lib/languages/css'),
        import('highlight.js/lib/languages/sql'),
        import('highlight.js/lib/languages/yaml'),
        import('highlight.js/lib/languages/diff'),
        import('highlight.js/lib/languages/markdown'),
        import('highlight.js/lib/languages/plaintext'),
      ]);
      const lowlight = createLowlight(
        Object.fromEntries(grammarImports.map((m, i) => [HIGHLIGHT_LANGUAGES[i], m.default])),
      );
      const { createParser } = await import('@milkdown/plugin-highlight/lowlight');
      // A fence with an unregistered language (e.g. ```rust) must degrade to
      // plain text instead of throwing inside the highlighter.
      const highlightParser = createParser({
        highlight: (language, code) => {
          try {
            return lowlight.highlight(language, code);
          } catch {
            return lowlight.highlight('plaintext', code);
          }
        },
        highlightAuto: (code) => lowlight.highlightAuto(code),
      });
      const { replaceAll } = await import('@milkdown/kit/utils');

      if (isStale()) return;

      const host = this.elRef.nativeElement.querySelector('.milkdown-host') as HTMLElement | null;

      if (!host) {
        this.enterFallbackMode();
        return;
      }

      // The editable ProseMirror div carries no name, role or model of its
      // own (re-read from prosemirror-view 1.42: it supplies `contenteditable`
      // and nothing else), so the surface was announced inconsistently and unnamed.
      // Named with `milkdownEditor.editor`, its own key in all 11 locales. It
      // used to borrow the `wysiwyg` key — the string "WYSIWYG", which labels
      // the button that switches TO the rich-text view, so a screen reader
      // announced the editor by a mode name rather than by what it edits.
      // (Written without the literal key name: the i18n gate reads key-shaped
      // strings out of source comments and would report it as missing.)
      const editorName = await firstValueFrom(this.transloco.selectTranslate('milkdownEditor.editor'));
      const editor = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, host);
          ctx.set(defaultValueCtx, seed ?? this.content() ?? '');
          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
            // Clean up HTML artifacts that Milkdown may emit
            const cleaned = markdown.replace(/<br\s*\/?>/g, '').replace(/\n{3,}/g, '\n\n');

            this.lastMarkdown = cleaned;
            this.suppressContentEffect = true;
            this.contentChange.emit(cleaned);
          });
          // Configure highlight plugin for syntax highlighting in code blocks
          ctx.set(highlightPluginConfig.key, { parser: highlightParser });
          // Publish the formatting state of the current selection so the
          // four formatting toggles can report `aria-pressed`.
          //
          // A plugin's `view().update()` hook, NOT a `dispatchTransaction`
          // override. It observes every applied transaction from the outside, so
          // it cannot interfere with how the transaction is applied.
          //
          // The override it replaced read `view.props.dispatchTransaction` and
          // called it — but `view.props` holds only the props the view was
          // constructed with, and ProseMirror's default ("apply the transaction")
          // is a branch inside `EditorView.prototype.dispatch`, not a prop
          // (prosemirror-view 1.42.3, `dist/index.js:5913-5918`). Milkdown
          // builds the view without that prop, so the captured value was
          // `undefined` and the wrapper silently DISCARDED every transaction:
          // typing, pasting and the toolbar commands all became no-ops, and
          // because the document never changed, Milkdown's own
          // `markdownUpdated` listener (guarded by `!prevDoc.eq(doc)`) never
          // fired either — so `contentChange` never emitted and the comment
          // submit button stayed disabled.
          ctx.update(prosePluginsCtx, (prev) =>
            prev.concat(
              new Plugin({
                view: () => ({
                  update: (editorView) => this.syncActiveMarks(editorView.state),
                }),
              }),
            ),
          );
          // One merge, not two: read-only mode and the a11y attributes both live
          // in the same `editorViewOptionsCtx` slice.
          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            // Read-only mode at the ProseMirror level — no DOM hacks needed
            ...(this.readOnly() ? { editable: () => false } : {}),
            // Re-read from prosemirror-view 1.42: `attributes` is a direct
            // `EditorProps` member and may be an object OR a function of state.
            attributes: (state) => ({
              ...(typeof prev.attributes === 'function' ? prev.attributes(state) : prev.attributes),
              role: 'textbox',
              'aria-multiline': 'true',
              'aria-label': editorName,
            }),
          }));
        })
        .use(commonmarkPreset.commonmark)
        .use(gfmPreset.gfm)
        .use(listener)
        .use(history)
        .use(highlight)
        .create();

      if (isStale()) {
        await editor.destroy();
        return;
      }

      // The plugin above reads ProseMirror's own state on every transaction —
      // typing, arrow keys and the pointer alike — rather than guessing from DOM
      // events. Seed it once, because `update()` only runs on a state CHANGE.
      const view = await editor.action((ctx) => ctx.get(editorViewCtx));

      this.syncActiveMarks(view.state);

      this.commands = {
        strong: commonmarkPreset.toggleStrongCommand,
        emphasis: commonmarkPreset.toggleEmphasisCommand,
        strikethrough: gfmPreset.toggleStrikethroughCommand,
        inlineCode: commonmarkPreset.toggleInlineCodeCommand,
        bulletList: commonmarkPreset.wrapInBulletListCommand,
        orderedList: commonmarkPreset.wrapInOrderedListCommand,
        blockquote: commonmarkPreset.wrapInBlockquoteCommand,
        codeBlock: commonmarkPreset.createCodeBlockCommand,
        heading: commonmarkPreset.wrapInHeadingCommand,
        hr: commonmarkPreset.insertHrCommand,
      };
      this.callCommandFn = callCommand as (key: unknown, payload?: unknown) => unknown;
      this.replaceAllFn = replaceAll as (markdown: string, flush?: boolean) => unknown;
      this.editorInstance = {
        action: (fn: unknown) => editor.action(fn as never),
        destroy: async () => {
          await editor.destroy();
        },
      };
      this.editorReady.set(true);
      this.readyChange.emit(true);
    } catch (err) {
      // Milkdown failed to load — surface a toast and fall back to the textarea
      this.notify.error(getErrorMessage(err));
      this.enterFallbackMode();
    }
  }
}
