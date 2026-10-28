'use strict';
const vscode = require('vscode');
const path = require('path');

const LANGS = ['html', 'javascript', 'typescript', 'javascriptreact', 'typescriptreact'];
const CSS_EXTS = ['.module.css', '.css', '.module.scss', '.scss', '.module.less', '.less'];
const CSS_LANGS = ['css', 'scss', 'less'];
const IDENT = /^[A-Za-z_$][\w$]*$/;
const CLASS_WORD = /^-?[A-Za-z_][\w-]*$/;
const CMD_CREATE = 'cssQuick.create';

// 'isim.' yazıldığında CSS aranmayacak, JS'e ait bilinen isimler
const JS_GLOBALS = new Set([
  'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Promise',
  'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Intl', 'Reflect', 'Proxy', 'Error', 'RegExp', 'BigInt',
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'process',
  'module', 'exports', 'require', 'global', 'globalThis', 'this', 'event', 'e', 'props', 'state', 'req',
  'res', 'ctx', 'self', 'super', 'React', 'Buffer', 'URL', 'URLSearchParams', 'crypto', 'performance',
  'screen', 'element', 'el', 'node', 'target', 'ref', 'refs', 'style', 'import'
]);

const cfg = () => vscode.workspace.getConfiguration('cssQuick');
const isHtml = (doc) => doc.languageId === 'html';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function exists(p) {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(p));
    return true;
  } catch {
    return false;
  }
}

function toIdent(name) {
  let s = name.replace(/[^\w$]+(.)?/g, (m, c) => (c ? c.toUpperCase() : ''));
  if (!/^[A-Za-z_$]/.test(s)) s = '_' + s;
  return s;
}

/* ---------- CSS ayrıştırma ---------- */

const blank = (s) => s.replace(/[^\n]/g, ' ');

// Uzunluğu koruyarak yorum / string / parantez içini boşlukla doldurur
function clean(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/"[^"\n]*"|'[^'\n]*'/g, blank)
    .replace(/\([^()\n]*\)/g, blank)
    .replace(/\/\/[^\n]*/g, blank);
}

function parseClasses(text) {
  const c = clean(text);
  // Tailwind kaçışlı sınıflar (.md\:flex) ve rakamla başlayan değerler (.5rem) elenir
  const re = /\.(-?[A-Za-z_][\w-]*)(?![\w\\-])/g;
  const map = new Map();
  let m;
  while ((m = re.exec(c))) {
    if (!map.has(m[1])) map.set(m[1], m.index);
  }
  return map;
}

function ruleText(text, idx) {
  const end = text.indexOf('}', idx);
  return text.slice(idx, end < 0 ? idx + 200 : end + 1);
}

function bodyPos(cssDoc, idx) {
  const t = cssDoc.getText();
  const b = t.indexOf('{', idx);
  if (b < 0) return cssDoc.positionAt(idx);
  const p = cssDoc.positionAt(b + 1);
  if (p.character >= cssDoc.lineAt(p.line).text.length && p.line + 1 < cssDoc.lineCount) {
    return new vscode.Position(p.line + 1, cssDoc.lineAt(p.line + 1).text.length);
  }
  return p;
}

/* ---------- Tailwind algılama ---------- */

const twCache = new Map();

async function readText(p) {
  return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(p))).toString('utf8');
}

async function detectTailwind(folder, mode) {
  const info = { on: mode === 'on', v4entry: null };
  if (!folder) return info;
  const root = folder.uri.fsPath;
  if (!info.on) {
    for (const f of ['tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs', 'tailwind.config.ts']) {
      if (await exists(path.join(root, f))) {
        info.on = true;
        break;
      }
    }
  }
  if (!info.on) {
    try {
      const pkg = await readText(path.join(root, 'package.json'));
      if (/"(?:tailwindcss|@tailwindcss\/[\w-]+)"/.test(pkg)) info.on = true;
    } catch {
      /* package.json yok */
    }
  }
  if (info.on) {
    try {
      const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.css'), '**/node_modules/**', 60);
      for (const f of files) {
        const t = await readText(f.fsPath);
        if (/@import\s+(?:url\()?["']tailwindcss(?:["']|\/)/.test(t)) {
          info.v4entry = f.fsPath; // Tailwind v4 giriş dosyası (@reference için)
          break;
        }
      }
    } catch {
      /* önemsiz */
    }
  }
  return info;
}

async function tailwindInfo(uri) {
  const mode = cfg().get('tailwind', 'auto');
  if (mode === 'off') return { on: false, v4entry: null };
  const folder = vscode.workspace.getWorkspaceFolder(uri) || (vscode.workspace.workspaceFolders || [])[0];
  const key = (folder ? folder.uri.fsPath : '') + '|' + mode;
  const hit = twCache.get(key);
  if (hit && Date.now() - hit.t < 30000) return hit.v;
  const v = await detectTailwind(folder, mode);
  twCache.set(key, { t: Date.now(), v });
  return v;
}

/* ---------- Kaynak dosya bağlamı ---------- */

function cssImports(text) {
  const res = [];
  const re1 = /import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+\.(?:css|scss|less))['"]/g;
  const re2 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+\.(?:css|scss|less))['"]\s*\)/g;
  let m;
  while ((m = re1.exec(text))) res.push({ ident: m[1], spec: m[2] });
  while ((m = re2.exec(text))) res.push({ ident: m[1], spec: m[2] });
  return res;
}

// "isim"  veya  "klasör/alt/isim"  (./, ../, @/, ~/ başlangıçları da olur)
const SEG = '[\\p{L}\\p{N}_@~$-]+';
const EXPR = `(?:(?:\\.{1,2}|${SEG})\\/)+[\\p{L}\\p{N}_$-]+|[A-Za-z_$][\\w$]*`;
const DOT_RE = new RegExp(`(${EXPR})\\.([\\p{L}\\p{N}_-]*)$`, 'u');
const DOT_END_RE = new RegExp(`(${EXPR})\\.$`, 'u');
const ATTR_OPEN = /\b(style|class|className)\s*=\s*(?:(["'])[^"']*|\{[^}]*)$/;

function insideString(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === q) q = null;
    } else if (c === '"' || c === "'" || c === '`') {
      q = c;
    }
  }
  return !!q;
}

function getContext(doc, pos) {
  const html = isHtml(doc);
  const line = doc.lineAt(pos.line).text;
  const before = line.slice(0, pos.character);

  // buton.da|   /   klasör/buton.da|   /   styles.da|
  let m = DOT_RE.exec(before);
  if (m) {
    const expr = m[1];
    const word = m[2];
    const fullStart = m.index;
    const pathForm = expr.includes('/');
    if (!pathForm && fullStart > 0 && before[fullStart - 1] === '.') return null; // a.b.c zinciri
    const prefix = before.slice(0, fullStart);
    if (/(^|[^:])\/\/|\/\*/.test(prefix)) return null; // yorum satırı
    if (/\bstyle\s*=\s*\{\s*\{/.test(prefix)) return null; // style={{ ... }}
    const am = ATTR_OPEN.exec(prefix);
    if (insideString(prefix) && !am) return null;
    if (html && !am) return null;
    const ctx = {
      mode: 'dot',
      expr,
      pathForm,
      word,
      start: pos.character - word.length,
      fullStart,
      line: pos.line,
      quote: am ? am[2] || '{' : null,
      attr: null
    };
    if (am && am[1] === 'style') ctx.attr = { name: 'style', start: am.index, end: am.index + 5 };
    return ctx;
  }

  // <div style=  |  class="a b|  |  className={da|
  m = /\b(style|class|className)\s*=\s*(?:(["'])([^"']*)|(\{)\s*([\w$-]*))?$/.exec(before);
  if (!m) return null;
  let word = '';
  let quote = null;
  if (m[2]) {
    quote = m[2];
    word = /[\w-]*$/.exec(m[3])[0];
  } else if (m[4]) {
    quote = '{';
    word = m[5] || '';
  }
  return {
    mode: 'attr',
    expr: null,
    word,
    quote,
    start: pos.character - word.length,
    attr: { name: m[1], start: m.index, end: m.index + m[1].length },
    line: pos.line
  };
}

async function fromPath(p, ident, imported) {
  return { path: p, exists: await exists(p), ident, imported, useModule: true };
}

function resolveFolder(doc, folderPart) {
  const dir = path.dirname(doc.uri.fsPath);
  const ws = vscode.workspace.getWorkspaceFolder(doc.uri) || (vscode.workspace.workspaceFolders || [])[0];
  const root = ws ? ws.uri.fsPath : dir;
  if (folderPart === '@' || folderPart.startsWith('@/')) return path.resolve(root, 'src', folderPart.slice(2));
  if (folderPart === '~' || folderPart.startsWith('~/')) return path.resolve(root, folderPart.slice(2));
  return path.resolve(dir, folderPart);
}

function identSeenElsewhere(doc, ident) {
  if (isHtml(doc)) return false;
  const re = new RegExp('(?<![\\w$])' + escapeRe(ident) + '(?![\\w$])', 'g');
  let n = 0;
  while (re.exec(doc.getText())) n++;
  return n > 1; // yazdığımız yer 1
}

// expr: "buton" | "klasör/buton" | null (class/style= bağlamı → dosya adıyla aynı isim)
async function resolveTarget(doc, expr, opts = {}) {
  const dir = path.dirname(doc.uri.fsPath);
  const html = isHtml(doc);
  const base = path.basename(doc.uri.fsPath).replace(/\.[^.]+$/, '');
  const aliases = cfg().get('aliases', ['styles']);
  const stylesFolder = cfg().get('stylesFolder', '');
  const imports = html ? [] : cssImports(doc.getText());
  const importedAt = (p) => imports.find((i) => path.resolve(dir, i.spec) === p);

  if (expr && !expr.includes('/')) {
    const imp = imports.find((i) => i.ident === expr);
    if (imp) return fromPath(path.resolve(dir, imp.spec), expr, true);
  } else if (!expr && imports.length) {
    return fromPath(path.resolve(dir, imports[0].spec), imports[0].ident, true);
  }

  let name;
  let ident;
  let folderPart = '';
  let isAlias = false;
  let isPath = false;
  if (!expr) {
    name = base;
    ident = 'styles';
    isAlias = true;
  } else if (expr.includes('/')) {
    const i = expr.lastIndexOf('/');
    folderPart = expr.slice(0, i);
    name = expr.slice(i + 1);
    ident = toIdent(name);
    isPath = true;
  } else if (aliases.includes(expr)) {
    name = base;
    ident = expr;
    isAlias = true;
  } else {
    name = expr;
    ident = expr;
  }

  const dirs = folderPart
    ? [resolveFolder(doc, folderPart)]
    : stylesFolder
      ? [path.resolve(dir, stylesFolder), dir]
      : [dir];

  for (const d of dirs) {
    for (const ext of CSS_EXTS) {
      const p = path.join(d, name + ext);
      if (await exists(p)) {
        const imp = importedAt(p);
        return {
          path: p,
          exists: true,
          ident: imp ? imp.ident : ident,
          imported: !!imp,
          useModule: !html && (!!imp || ext.includes('.module.'))
        };
      }
    }
  }

  const unknown = !isAlias && !isPath;
  if (unknown && opts.check) {
    if (!cfg().get('createForUnknownIdentifiers', true)) return null;
    if (JS_GLOBALS.has(expr) || identSeenElsewhere(doc, expr)) return null;
  }
  return {
    path: path.join(dirs[0], name + (html ? '.css' : '.module.css')),
    exists: false,
    ident,
    imported: false,
    useModule: !html,
    unknown
  };
}

/* ---------- Metin üretimi ---------- */

// Kod içine yazılacak başvuru ve değiştirilecek aralığın başlangıç sütunu
function buildRef(html, ctx, name, target) {
  const plain = IDENT.test(name);
  const member = plain ? `.${name}` : `['${name}']`;
  const quoted = ctx.quote === '"' || ctx.quote === "'";

  if (ctx.mode === 'dot') {
    if (target.useModule && !html) {
      if (ctx.pathForm) return { startCol: ctx.fullStart, text: target.ident + member };
      if (plain) return { startCol: ctx.start, text: name };
      return { startCol: ctx.start - 1, text: member };
    }
    return { startCol: ctx.fullStart, text: quoted || html ? name : `"${name}"` };
  }

  if (quoted) return { startCol: ctx.start, text: name };
  if (target.useModule && !html) {
    const e = target.ident + member;
    return { startCol: ctx.start, text: ctx.quote === '{' ? e : `{${e}}` };
  }
  return { startCol: ctx.start, text: `"${name}"` };
}

function renameEdit(doc, ctx) {
  if (!ctx.attr || ctx.attr.name !== 'style') return null;
  return vscode.TextEdit.replace(
    new vscode.Range(ctx.line, ctx.attr.start, ctx.line, ctx.attr.end),
    isHtml(doc) ? 'class' : 'className'
  );
}

function importEdit(doc, target) {
  const text = doc.getText();
  const dir = path.dirname(doc.uri.fsPath);
  let rel = path.relative(dir, target.path).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = './' + rel;

  if (isHtml(doc)) {
    if (new RegExp(escapeRe(path.basename(target.path))).test(text)) return null;
    const i = text.search(/<\/head>/i);
    if (i < 0) return null;
    const p = doc.positionAt(i);
    return vscode.TextEdit.insert(new vscode.Position(p.line, 0), `  <link rel="stylesheet" href="${rel}">\n`);
  }
  if (target.imported) return null;
  if (new RegExp(`['"]${escapeRe(rel)}['"]`).test(text)) return null;
  const stmt = target.useModule ? `import ${target.ident} from '${rel}';` : `import '${rel}';`;
  let last = -1;
  let m;
  const re = /^import\b[^;'"]*?['"][^'"]+['"];?/gm;
  while ((m = re.exec(text))) last = m.index + m[0].length;
  if (last < 0) return vscode.TextEdit.insert(new vscode.Position(0, 0), stmt + '\n');
  return vscode.TextEdit.insert(doc.positionAt(last), '\n' + stmt);
}

/* ---------- Öneri sağlayıcı ---------- */

const provider = {
  async provideCompletionItems(doc, pos) {
    const ctx = getContext(doc, pos);
    if (!ctx) return undefined;
    const html = isHtml(doc);
    const target = await resolveTarget(doc, ctx.expr, { check: true });
    if (!target) return undefined;
    const tw = await tailwindInfo(doc.uri);
    const lineText = doc.lineAt(pos.line).text;

    let classes = new Map();
    let cssText = '';
    if (target.exists) {
      try {
        cssText = (await vscode.workspace.openTextDocument(vscode.Uri.file(target.path))).getText();
        classes = parseClasses(cssText);
      } catch {
        /* dosya okunamadı */
      }
    }

    const extra = [];
    const re = renameEdit(doc, ctx);
    if (re) extra.push(re);
    const ie = importEdit(doc, target);
    if (ie) extra.push(ie);

    const items = [];
    for (const [name, idx] of classes) {
      const ref = buildRef(html, ctx, name, target);
      const it = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
      it.detail = path.basename(target.path);
      it.documentation = new vscode.MarkdownString().appendCodeblock(ruleText(cssText, idx), 'css');
      it.insertText = ref.text;
      it.range = new vscode.Range(pos.line, ref.startCol, pos.line, pos.character);
      it.filterText = lineText.slice(ref.startCol, ctx.start) + name;
      it.sortText = '0' + name;
      if (extra.length) it.additionalTextEdits = extra;
      items.push(it);
    }

    // Tailwind projelerinde class/className içindeki sözcükler çoğunlukla yardımcı sınıflardır → Oluştur gösterme
    const tailwindUtilityCtx = tw.on && ctx.mode === 'attr' && ctx.attr.name !== 'style';
    const word = ctx.word;
    if (word && CLASS_WORD.test(word) && !classes.has(word) && !tailwindUtilityCtx) {
      const ref = buildRef(html, ctx, word, target);
      const typed = lineText.slice(ref.startCol, pos.character);
      const rel = vscode.workspace.asRelativePath(vscode.Uri.file(target.path), false);
      const it = new vscode.CompletionItem(`➕ Oluştur: .${word}`, vscode.CompletionItemKind.Event);
      it.detail = target.exists ? `${rel} içine eklenecek` : `${rel} yok — oluşturulmadan önce sorulur`;
      it.insertText = typed; // yazdığın metne dokunma; onaydan sonra komut düzenler
      it.range = new vscode.Range(pos.line, ref.startCol, pos.line, pos.character);
      it.filterText = typed;
      it.sortText = '￿';
      it.command = {
        command: CMD_CREATE,
        title: 'Stili oluştur',
        arguments: [
          {
            docUri: doc.uri.toString(),
            name: word,
            ctx,
            target: {
              path: target.path,
              ident: target.ident,
              useModule: target.useModule,
              imported: target.imported
            },
            tailwind: tw,
            fromCompletion: true,
            line: pos.line,
            startCol: ref.startCol,
            endCol: pos.character,
            typed
          }
        ]
      };
      items.push(it);
    }
    return items.length ? new vscode.CompletionList(items, true) : undefined;
  }
};

/* ---------- Oluştur + peek düzenleme ---------- */

async function peekAt(sourceUri, cssUri, pos) {
  let editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== sourceUri.toString()) {
    editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === sourceUri.toString());
  }
  if (!editor) {
    await vscode.window.showTextDocument(cssUri, { selection: new vscode.Range(pos, pos) });
    return;
  }
  await vscode.commands.executeCommand(
    'editor.action.peekLocations',
    editor.document.uri,
    editor.selection.active,
    [new vscode.Location(cssUri, pos)],
    'peek'
  );
}

async function confirmCreate(name, cssPath, dirExists) {
  const rel = vscode.workspace.asRelativePath(vscode.Uri.file(cssPath), false);
  const relDir = vscode.workspace.asRelativePath(vscode.Uri.file(path.dirname(cssPath)), false);
  const msg = dirExists
    ? `${rel} bulunamadı. Oluşturulup içine .${name} eklensin mi?`
    : `${relDir}/ klasörü ve ${path.basename(cssPath)} bulunamadı. Klasör + dosya oluşturulup içine .${name} eklensin mi?`;
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(check) Evet, oluştur', description: rel, ok: true },
      { label: '$(close) Vazgeç', ok: false }
    ],
    { placeHolder: msg, ignoreFocusOut: true }
  );
  return !!(pick && pick.ok);
}

async function applySourceEdits(doc, args) {
  const range = new vscode.Range(args.line, args.startCol, args.line, args.endCol);
  if (args.line >= doc.lineCount || doc.getText(range) !== args.typed) return; // bu arada metin değişmiş
  const edits = [];
  const ref = buildRef(isHtml(doc), args.ctx, args.name, args.target);
  if (ref.startCol === args.startCol && ref.text !== args.typed) edits.push(vscode.TextEdit.replace(range, ref.text));
  const re = renameEdit(doc, args.ctx);
  if (re) edits.push(re);
  const ie = importEdit(doc, args.target);
  if (ie) edits.push(ie);
  if (!edits.length) return;
  const we = new vscode.WorkspaceEdit();
  we.set(doc.uri, edits);
  await vscode.workspace.applyEdit(we);
}

function cssHeader(args) {
  const tw = args.tailwind;
  if (tw && tw.on && tw.v4entry && path.resolve(tw.v4entry) !== path.resolve(args.target.path)) {
    let rel = path.relative(path.dirname(args.target.path), tw.v4entry).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return `@reference "${rel}";\n\n`; // Tailwind v4: @apply için gerekli
  }
  return '';
}

async function createStyle(args) {
  const sourceUri = vscode.Uri.parse(args.docUri);
  const doc = await vscode.workspace.openTextDocument(sourceUri);
  const t = args.target;
  const cssUri = vscode.Uri.file(t.path);
  const dirPath = path.dirname(t.path);
  const fileExists = await exists(t.path);

  if (!fileExists) {
    const ok = await confirmCreate(args.name, t.path, await exists(dirPath));
    if (!ok) return; // yazdığın metin olduğu gibi kalır
  }
  if (args.fromCompletion) await applySourceEdits(doc, args);

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirPath));
  if (!fileExists) await vscode.workspace.fs.writeFile(cssUri, Buffer.from(cssHeader(args), 'utf8'));

  const cssDoc = await vscode.workspace.openTextDocument(cssUri);
  const name = args.name;
  let text = cssDoc.getText();
  let idx = parseClasses(text).get(name);
  let pos;

  if (idx === undefined) {
    const seeded = !!(args.tailwind && args.tailwind.on && cfg().get('tailwindApply', true));
    const sep = text.length === 0 ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    const edit = new vscode.WorkspaceEdit();
    edit.insert(cssUri, cssDoc.positionAt(text.length), `${sep}.${name} {\n  ${seeded ? '@apply ;' : ''}\n}\n`);
    await vscode.workspace.applyEdit(edit);
    if (!seeded) await cssDoc.save(); // "@apply ;" yarım kalmış CSS olur, Ctrl+S'e bırak
    text = cssDoc.getText();
    idx = parseClasses(text).get(name);
    pos = new vscode.Position(cssDoc.positionAt(idx || 0).line + 1, seeded ? 2 + '@apply '.length : 2);
  } else {
    pos = bodyPos(cssDoc, idx);
  }
  await new Promise((r) => setTimeout(r, 60)); // kaynak dosyadaki düzenlemeler otursun
  await peekAt(sourceUri, cssUri, pos);
}

async function editAtCursor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const pos = editor.selection.active;
  const range = doc.getWordRangeAtPosition(pos, /[\w-]+/);
  if (!range) return;
  const name = doc.getText(range);
  const before = doc.lineAt(pos.line).text.slice(0, range.start.character);
  const m = DOT_END_RE.exec(before);
  const target = await resolveTarget(doc, m ? m[1] : null);
  if (!target) return;
  await createStyle({
    docUri: doc.uri.toString(),
    name,
    target: { path: target.path, ident: target.ident, useModule: target.useModule, imported: target.imported },
    tailwind: await tailwindInfo(doc.uri),
    fromCompletion: false
  });
}

/* ---------- Kaydet + Live Preview yenile ---------- */

async function refreshPreview() {
  try {
    const cmds = await vscode.commands.getCommands(true);
    const found = cmds.filter((c) => /^livePreview\./i.test(c) && /refresh|reload/i.test(c));
    for (const c of found) {
      try {
        await vscode.commands.executeCommand(c);
      } catch {
        /* komut argüman istiyor olabilir */
      }
    }
  } catch {
    /* önemsiz */
  }
}

async function saveCss() {
  for (const d of vscode.workspace.textDocuments) {
    if (d.isDirty && CSS_LANGS.includes(d.languageId)) await d.save();
  }
  await vscode.commands.executeCommand('workbench.action.files.save');
  await refreshPreview();
}

function activate(context) {
  const selector = LANGS.map((language) => ({ language }));
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, provider, '.', '/', '=', '"', "'", '{', ' '),
    vscode.commands.registerCommand(CMD_CREATE, createStyle),
    vscode.commands.registerCommand('cssQuick.editAtCursor', editAtCursor),
    vscode.commands.registerCommand('cssQuick.saveCss', saveCss),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (CSS_LANGS.includes(d.languageId)) refreshPreview();
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate, _test: { parseClasses, getContext, buildRef, DOT_RE, toIdent } };
