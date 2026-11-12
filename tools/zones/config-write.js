// Rewrite zones.config.json compactly after programmatic edits.
//   node config-write.js '<js expression mutating c>'
const fs = require('fs');
const f = __dirname + '/zones.config.json';
const c = JSON.parse(fs.readFileSync(f, 'utf8'));
if (process.argv[2]) new Function('c', process.argv[2])(c);
let s = '{\n  "_doc": ' + JSON.stringify(c._doc);
for (const [id, m] of Object.entries(c)) {
  if (id === '_doc') continue;
  s += ',\n  ' + JSON.stringify(id) + ': {\n    "official": ' + JSON.stringify(m.official);
  if (m.align) s += ',\n    "align": ' + JSON.stringify(m.align);
  if (m.drawn) s += ',\n    "drawn": {\n' + Object.entries(m.drawn).map(([n, p]) => '      ' + JSON.stringify(n) + ': ' + JSON.stringify(p)).join(',\n') + '\n    }';
  s += ',\n    "zones": {\n' + Object.entries(m.zones).map(([n, p]) => '      ' + JSON.stringify(n) + ': ' + JSON.stringify(p)).join(',\n') + '\n    }\n  }';
}
fs.writeFileSync(f, s + '\n}\n');
