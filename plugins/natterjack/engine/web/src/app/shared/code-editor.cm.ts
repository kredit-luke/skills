/**
 * The CodeMirror half of the code editor, imported dynamically so it lands in its
 * own chunk. Languages are loaded per file type on first use.
 */
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { ExploreLang } from '../core/explore-paths';

export { EditorView };

export const readOnly = new Compartment();
export const readOnlyExt = (ro: boolean): Extension => [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)];

const legacy = async (load: () => Promise<StreamParser<unknown>>) => StreamLanguage.define(await load());

export async function language(lang: ExploreLang): Promise<Extension> {
  switch (lang) {
    case 'javascript': return (await import('@codemirror/lang-javascript')).javascript();
    case 'jsx': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'typescript': return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'tsx': return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true });
    case 'json': return (await import('@codemirror/lang-json')).json();
    case 'html': return (await import('@codemirror/lang-html')).html();
    case 'css': return (await import('@codemirror/lang-css')).css();
    case 'scss': return legacy(async () => (await import('@codemirror/legacy-modes/mode/css')).sCSS);
    case 'markdown': return (await import('@codemirror/lang-markdown')).markdown();
    case 'go': return (await import('@codemirror/lang-go')).go();
    case 'csharp': return legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).csharp);
    case 'yaml': return legacy(async () => (await import('@codemirror/legacy-modes/mode/yaml')).yaml);
    case 'xml': return legacy(async () => (await import('@codemirror/legacy-modes/mode/xml')).xml);
    case 'shell': return legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell);
    case 'powershell': return legacy(async () => (await import('@codemirror/legacy-modes/mode/powershell')).powerShell);
    case 'python': return legacy(async () => (await import('@codemirror/legacy-modes/mode/python')).python);
    case 'sql': return legacy(async () => (await import('@codemirror/legacy-modes/mode/sql')).pgSQL);
    case 'dockerfile': return legacy(async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile);
    case 'toml': return legacy(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml);
    case 'ini': return legacy(async () => (await import('@codemirror/legacy-modes/mode/properties')).properties);
    default: return [];
  }
}

// Colors picked for contrast on the dashboard's white surface.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: '#7a3db8' },
  { tag: [t.definitionKeyword, t.moduleKeyword], color: '#7a3db8' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#0a7a3d' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#b35a00' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#7b8194', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace], color: '#1f5fa8' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#b3261e' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: '#1a1f36' },
  { tag: [t.propertyName, t.attributeName], color: '#2d4a8a' },
  { tag: [t.tagName, t.angleBracket], color: '#b3261e' },
  { tag: [t.attributeValue], color: '#0a7a3d' },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: '#8a6d00' },
  { tag: t.heading, fontWeight: '700', color: '#1a1f36' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: '#1f5fa8', textDecoration: 'underline' },
  { tag: t.invalid, color: '#d11' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--text-faint)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'rgba(31, 95, 168, .05)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(31, 95, 168, .08)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: '#cfdcf5 !important' },
});

export function createState(text: string, lang: Extension, ro: boolean, on: { changed(text: string): void; save(): void }): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { on.save(); return true; } }, indentWithTab]),
      basicSetup,
      syntaxHighlighting(highlight),
      theme,
      lang,
      readOnly.of(readOnlyExt(ro)),
      EditorView.updateListener.of((u) => { if (u.docChanged) on.changed(u.state.doc.toString()); }),
    ],
  });
}
