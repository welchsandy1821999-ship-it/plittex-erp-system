const fs = require('fs');
const path = 'public/js/dashboard.js';
let content = fs.readFileSync(path, 'utf8');

// 1. replace style.display = 'none' -> classList.add('hidden')
content = content.replace(/style\.display\s*=\s*'none'/g, `classList.add('hidden')`);
// wait, we have things like warnEl.style.display = 'none';
// -> warnEl.classList.add('hidden');

// Let's do it safer for display: block and none:
// warnEl.style.display = 'block' -> warnEl.classList.remove('hidden')
// warnEl.style.display = 'none' -> warnEl.classList.add('hidden')
content = content.replace(/(\w+)\.style\.display\s*=\s*'block'/g, `$1.classList.remove('hidden')`);
content = content.replace(/(\w+)\.style\.display\s*=\s*'none'/g, `$1.classList.add('hidden')`);
content = content.replace(/(\w+)\.style\.display\s*=\s*'flex'/g, `$1.classList.remove('hidden')`);

// 2. inline styles in strings
// style="padding: 20px; text-align: center;" -> class="p-20 text-center"
content = content.replace(/style="padding: 20px; text-align: center;"/g, `class="p-20 text-center"`);

// style="height: 26px;" -> class="h-26"
content = content.replace(/style="height: 26px;"/g, `class="h-26"`);

// style="background: ${colors[grp]}15; padding: 10px 15px; font-weight: bold; color: ${colors[grp]}; border-bottom: 2px solid ${colors[grp]}; text-transform: uppercase;"
// Keep dynamic ${colors[grp]} inline style:
content = content.replace(
    /style="background: \$\{colors\[grp\]\}15; padding: 10px 15px; font-weight: bold; color: \$\{colors\[grp\]\}; border-bottom: 2px solid \$\{colors\[grp\]\}; text-transform: uppercase;"/g,
    `class="px-15 p-10 font-bold text-uppercase" style="background: \$\{colors[grp]\}15; color: \$\{colors[grp]\}; border-bottom: 2px solid \$\{colors[grp]\};"`
);

// style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px; width: 130px;"
content = content.replace(/style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px; width: 130px;"/g, `class="dash-period-input dash-period-input-date"`);

// style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px;"
content = content.replace(/style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px;"/g, `class="dash-period-input"`);

// container.style.gap = '8px'; -> container.classList.add('gap-10');
content = content.replace(/container\.style\.gap\s*=\s*'8px';/g, `container.classList.add('gap-10');`);

// style="flex-direction: column;" -> class="flex-col"
content = content.replace(/style="display: flex; flex-direction: column; gap: 15px;"/g, `class="flex-col gap-15"`);

// style="font-weight: bold; font-size: 13px;" -> class="font-bold font-13"
content = content.replace(/style="font-weight: bold; font-size: 13px;"/g, `class="font-bold font-13"`);

// style="color: var\(--primary\);" -> class="text-primary"
content = content.replace(/style="color: var\(--primary\);"/g, `class="text-primary"`);

// style="margin: 0;" -> class="m-0"
content = content.replace(/style="margin: 0;"/g, `class="m-0"`);

// style="font-weight: 600; margin-bottom: 4px; display: block;" -> class="font-600 mb-5 block"
content = content.replace(/style="font-weight: 600; margin-bottom: 4px; display: block;"/g, `class="font-600 mb-5 block"`);

// style="font-size: 14px; padding: 10px;" -> class="font-14 p-10"
content = content.replace(/style="font-size: 14px; padding: 10px;"/g, `class="font-14 p-10"`);

// style="font-size: 14px; padding: 10px; font-weight: 600;" -> class="font-14 p-10 font-600"
content = content.replace(/style="font-size: 14px; padding: 10px; font-weight: 600;"/g, `class="font-14 p-10 font-600"`);

// style="font-size: 13px; padding: 8px;" -> class="font-13 p-5" // approximative
content = content.replace(/style="font-size: 13px; padding: 8px;"/g, `class="font-13 p-5"`);

// style="color: \$\{groupColor\};" class="mr-5"
// "dynamic variable -> keep"

// <span style="color: ${groupColor};" class="mr-5">📁</span>
// ok, keep it

// style="width: 16px; height: 16px; accent-color: ${groupColor};"
// dynamic keep it

// <div class="font-bold" style="color: ${groupColor};">
// keep it

// <div style="font-weight: bold; margin-bottom: 8px; display: block;">
content = content.replace(/style="font-weight: bold; margin-bottom: 8px; display: block;"/g, `class="font-bold mb-10 block"`);

fs.writeFileSync(path, content);
console.log('dashboard.js refactored.');
