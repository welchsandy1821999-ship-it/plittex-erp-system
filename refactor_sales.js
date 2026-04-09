const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'js', 'sales.js');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Replace imperative style.display toggling
content = content.replace(/([a-zA-Z0-9_]+)\.style\.display\s*=\s*'none'/g, "$1.classList.add('d-none')");
content = content.replace(/([a-zA-Z0-9_]+)\.style\.display\s*=\s*'(?:block|flex|inline|inline-block|)'/g, "$1.classList.remove('d-none')");

// 2. Replace imperative style.color
content = content.replace(/([a-zA-Z0-9_]+)\.style\.color\s*=\s*['"]var\(--(?:text-muted|muted)\)['"]/g, "$1.classList.add('text-muted'); $1.classList.remove('text-primary', 'text-success', 'text-danger')");
content = content.replace(/([a-zA-Z0-9_]+)\.style\.color\s*=\s*['"]var\(--(?:success|success-text)\)['"]/g, "$1.classList.add('text-success'); $1.classList.remove('text-primary', 'text-muted', 'text-danger')");
content = content.replace(/([a-zA-Z0-9_]+)\.style\.color\s*=\s*['"]var\(--(?:danger|danger-text)\)['"]/g, "$1.classList.add('text-danger'); $1.classList.remove('text-primary', 'text-success', 'text-muted')");
content = content.replace(/([a-zA-Z0-9_]+)\.style\.color\s*=\s*['"]var\(--primary\)['"]/g, "$1.classList.add('text-primary'); $1.classList.remove('text-muted', 'text-success', 'text-danger')");

// Also logic like: costEl.style.color = total > 0 ? 'var(--primary)' : 'var(--text-muted)';
content = content.replace(/costEl\.style\.color\s*=\s*total\s*>\s*0\s*\?\s*'var\(--primary\)'\s*:\s*'var\(--text-muted\)';/g, "costEl.classList.toggle('text-primary', total > 0); costEl.classList.toggle('text-muted', total <= 0);");
content = content.replace(/profitEl\.style\.color\s*=\s*netProfit\s*>=\s*0\s*\?\s*'var\(--success\)'\s*:\s*'var\(--danger\)';/g, "profitEl.classList.toggle('text-success', netProfit >= 0); profitEl.classList.toggle('text-danger', netProfit < 0);");
content = content.replace(/profitTotalEl\.style\.color\s*=\s*isProfitable\s*\?\s*'#1b5e20'\s*:\s*'#b71c1c';/g, "profitTotalEl.classList.toggle('text-success', isProfitable); profitTotalEl.classList.toggle('text-danger', !isProfitable);");

// 3. Replace inline HTML styles
// style="border-color: var(--border-color);" -> removed (assume default or use class)
content = content.replace(/style="border-color: var\(--border-color\);"/g, "");

// style="min-width: 0;" -> class="min-w-0" (or just remove if not critical)
content = content.replace(/style="min-width: 0;"/g, "");
// style="min-width: 100px;" -> remove, let flex handle it
content = content.replace(/style="min-width: 100px;"/g, "");
content = content.replace(/style="min-width: 80px;"/g, "");

// style="word-break: break-word; line-height: 1.2;"
content = content.replace(/style="word-break: break-word; line-height: 1\.2;"/g, "");

// <strong class="font-14 d-block" style="color: ${debtColor}; line-height: 1.2;">
content = content.replace(/style="color: \$\{debtColor\}; line-height: 1\.2;"/g, "class=\"font-14 d-block ${debtColor === 'var(--danger)' ? 'text-danger' : 'text-success'}\"");

// Replace multiple typical inline layouts
content = content.replace(/style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;"/g, "class=\"flex-between align-baseline mb-4\"");
content = content.replace(/style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;"/g, "class=\"flex-between align-center mb-10\"");
content = content.replace(/style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;"/g, "class=\"flex-between align-center mb-15\"");
content = content.replace(/style="margin-bottom: 12px; font-weight: 600;"/g, "class=\"mb-12 font-600\"");
content = content.replace(/style="text-align: left; margin-bottom: 12px; min-width: 140px;"/g, "class=\"text-left mb-12\"");
content = content.replace(/style="text-align: left; min-width: 140px;"/g, "class=\"text-left\"");
content = content.replace(/style="display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px dotted \$\{isProfitable \? '#a5d6a7' : '#ef9a9a'\};"/g, "class=\"flex-between py-3 border-bottom dashed ${isProfitable ? 'border-success' : 'border-danger'}\"");

// Handle colors in lists
content = content.replace(/style="color: \$\{isProfitable \? '#2e7d32' : '#c62828'\};"/g, "class=\"${isProfitable ? 'text-success' : 'text-danger'}\"");
content = content.replace(/style="font-weight:700; color: \$\{ok \? '#1b5e20' : '#b71c1c'\};"/g, "class=\"font-bold ${ok ? 'text-success' : 'text-danger'}\"");

content = content.replace(/style="font-size: 11px; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0\.5px;"/g, "class=\"font-11 font-600 text-muted text-uppercase tracking-wide\"");

// Handle dynamic widths
content = content.replace(/style="height: 100%; width: \$\{shipPercent\}%; background: linear-gradient\(90deg, \$\{shipColor\}\); border-radius: 4px; transition: width 0\.6s ease-out;"/g, "style=\"width: ${shipPercent}%; background: linear-gradient(90deg, ${shipColor});\"");
content = content.replace(/style="height: 100%; width: \$\{shipPercent\}%; background: \$\{shipColor\}; border-radius: 4px; transition: width 0\.6s ease-out;"/g, "style=\"width: ${shipPercent}%; background: ${shipColor};\"");

content = content.replace(/style="height: 6px; background-color: #e2e8f0; border-radius: 4px; overflow: hidden; margin-bottom: 3px;"/g, "class=\"h-18p bg-surface-alt border-radius-4 overflow-hidden mb-3\"");
content = content.replace(/style="font-size: 10px; color: #64748b;"/g, "class=\"font-11 text-muted\"");

content = content.replace(/style="color: \$\{prof \> 0 \? 'var\(--success\)' : 'var\(--danger\)'\}; font-size: 18px;"/g, "class=\"font-18 ${prof > 0 ? 'text-success' : 'text-danger'}\"");

// Clean general inline styles that match empty
content = content.replace(/class="([^"]*)"\s+style=""/g, 'class="$1"');

// 4. Save
fs.writeFileSync(filePath, content, 'utf8');
console.log('sales.js refactored successfully.');
