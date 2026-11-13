import * as acorn from 'acorn';
import fs from 'fs';
import { builtinModules } from 'module';
const src = fs.readFileSync(process.argv[2], 'utf8').replace(/^#!.*/, '');
const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
const mods = {};
const get = (m) => (mods[m] ??= { named: new Set(), default: 0, ns: 0, dyn: 0, req: 0 });
const isBuiltin = (s) => builtinModules.includes(s.replace(/^node:/, '')) || s.startsWith('node:');
for (const n of ast.body) {
  if (n.type === 'ImportDeclaration') {
    const m = get(n.source.value);
    for (const s of n.specifiers) {
      if (s.type === 'ImportDefaultSpecifier') m.default++;
      else if (s.type === 'ImportNamespaceSpecifier') m.ns++;
      else m.named.add(s.imported.name ?? s.imported.value);
    }
  } else if (n.type === 'ExportNamedDeclaration' && n.source || n.type === 'ExportAllDeclaration') get(n.source.value).named.add('*reexport');
}
// walk for dynamic import / require
const reqCalls = {};
(function walk(n) {
  if (!n || typeof n.type !== 'string') return;
  if (n.type === 'ImportExpression' && n.source.type === 'Literal') get(n.source.value).dyn++;
  if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.arguments.length === 1 && n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'string' && isBuiltin(n.arguments[0].value)) {
    const k = n.arguments[0].value; (reqCalls[k] ??= new Set()).add(n.callee.name); get(k).req++;
  }
  for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object' && k !== 'loc') walk(v); }
})(ast);
const out = {};
for (const [k, v] of Object.entries(mods).sort()) out[k] = { named: [...v.named].sort(), default: v.default, ns: v.ns, dyn: v.dyn, req: v.req, reqCallees: reqCalls[k] ? [...reqCalls[k]] : [] };
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) console.log(k, 'default', v.default, 'ns', v.ns, 'dyn', v.dyn, 'req', v.req, v.reqCallees.join(','), '\n   ', v.named.join(' '));
