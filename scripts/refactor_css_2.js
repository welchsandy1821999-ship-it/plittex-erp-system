const fs = require('fs');
const cssPath = 'public/css/modules.css';
const css = `
.font-600 { font-weight: 600; }
.block { display: block; }
.dash-period-input { padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px; }
.dash-period-input-date { width: 130px; }
.h-26 { height: 26px; }
.p-20 { padding: 20px; }
`;
fs.appendFileSync(cssPath, css);
console.log('modules.css updated with atomic css');
