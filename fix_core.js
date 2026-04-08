const fs = require('fs');
let C = fs.readFileSync('public/js/core.js', 'utf8');

C = C.replace(/const errBody = await res\.json\(\)\.catch\(\(\) => \(\{\}\)\);\s+throw new Error\(errBody\.error \|\| `HTTP \$\{res\.status\}`\);/g, 
`const errBody = await res.json().catch(() => ({}));
const err = new Error(errBody.error || errBody.warning || \`HTTP \${res.status}\`);
err.body = errBody;
throw err;`);

C = C.replace(/if \(typeof UI !== 'undefined' && UI\.toast\) UI\.toast\(error\.message/g, "if (typeof UI !== 'undefined' && UI.toast && !error.body?.warning) UI.toast(error.message");

fs.writeFileSync('public/js/core.js', C);
console.log('Fixed core.js interceptors');
