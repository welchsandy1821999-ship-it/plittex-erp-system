const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'js', 'sales.js');
let content = fs.readFileSync(filePath, 'utf8');

// Colors
content = content.replace(/style="border-color:\s*var\(--([a-zA-Z0-9-]+)\);?"/g, 'class="border-$1"');
content = content.replace(/style="max-height:\s*70vh;"/g, 'class="max-h-70vh"');
content = content.replace(/style="width:\s*80px;\s*text-align:\s*center;"/g, 'class="w-80p text-center"');
content = content.replace(/marginEl\.style\.color\s*=\s*'#fff';/g, "marginEl.classList.add('text-white');");
content = content.replace(/style="white-space:\s*nowrap;"/g, 'class="whitespace-nowrap"');

// Progress bars / specific text styles
content = content.replace(/style="font-size:\s*11px;\s*color:\s*#ef4444;\s*margin-top:\s*3px;\s*font-weight:\s*500;"/g, 'class="font-11 text-danger mt-3 font-600"');
content = content.replace(/style="text-align:\s*left;\s*margin-bottom:\s*12px;\s*min-width:\s*140px;"/g, 'class="text-left mb-12 min-w-140p"');
content = content.replace(/style="display:\s*flex;\s*justify-content:\s*space-between;\s*align-items:\s*baseline;\s*margin-bottom:\s*4px;"/g, 'class="flex-between align-baseline mb-4"');
content = content.replace(/style="font-size:\s*11px;\s*font-weight:\s*600;\s*color:\s*#475569;\s*text-transform:\s*uppercase;\s*letter-spacing:\s*0\.5px;"/g, 'class="font-11 font-600 text-muted text-uppercase tracking-wide"');

// Removing more structural styles that can be classes
content = content.replace(/style="height: 100%; width: \$\{([^}]+)\}%; background: linear-gradient\(90deg, \$\{([^}]+)\}\);"/g, 'style="width: ${$1}%; background: linear-gradient(90deg, ${$2});"');
content = content.replace(/style="vertical-align:\s*top;"/g, 'class="valign-top"');
content = content.replace(/style="vertical-align:\s*middle;\s*min-width:\s*180px;\s*padding:\s*12px\s*16px;"/g, 'class="valign-middle min-w-180p p-12-16"');

content = content.replace(/style="font-size:\s*12px;\s*color:\s*var\(--danger\);"/g, 'class="font-12 text-danger"');

// Active inputs
content = content.replace(/style="padding:\s*4px\s*6px;\s*font-size:\s*13px;\s*border-radius:\s*6px;\s*height:\s*32px;\s*width:\s*130px;"/g, 'class="p-4-6 font-13 border-radius-6 h-32p w-130p"');
content = content.replace(/style="padding:\s*4px\s*6px;\s*font-size:\s*13px;\s*border-radius:\s*6px;\s*height:\s*32px;\s*width:\s*190px;"/g, 'class="p-4-6 font-13 border-radius-6 h-32p min-w-190p"');
content = content.replace(/style="padding:\s*4px\s*6px;\s*font-size:\s*13px;\s*border-radius:\s*6px;\s*height:\s*32px;"/g, 'class="p-4-6 font-13 border-radius-6 h-32p"');


content = content.replace(/style="font-weight:\s*bold;"/g, 'class="font-bold"');

content = content.replace(/style="color:\s*var\(--warning-text\);\s*border-color:\s*var\(--warning-text\);"/g, 'class="text-warning border-warning"');
content = content.replace(/style="color:\s*var\(--primary\);\s*border-color:\s*var\(--primary\);"/g, 'class="text-primary border-primary"');
content = content.replace(/style="color:\s*var\(--danger\);"/g, 'class="text-danger"');

content = content.replace(/style="border:none;"/g, 'class="border-none"');

// Fix empty double classes "class="foo" class="bar"" -> "class="foo bar""
let oldContent;
do {
    oldContent = content;
    content = content.replace(/class="([^"]+)"\s+class="([^"]+)"/g, 'class="$1 $2"');
} while (oldContent !== content);

// More specific replacements
content = content.replace(/style="display:none"/g, 'class="d-none"');
content = content.replace(/style="display:\s*none;"/g, 'class="d-none"');
content = content.replace(/style="background:\s*#ef4444;\s*border-color:\s*#ef4444;"/g, 'class="bg-danger-btn border-danger text-white"');

content = content.replace(/style="padding:\s*15px;\s*text-align:\s*center;\s*font-size:\s*15px;"/g, 'class="p-15 text-center font-15"');
content = content.replace(/style="color:\s*var\(--text-muted\);"/g, 'class="text-muted"');

content = content.replace(/style="display:\s*flex;\s*justify-content:\s*space-between;\s*align-items:\s*flex-end;\s*margin-bottom:\s*18px;\s*padding-bottom:\s*12px;\s*border-bottom:\s*2px\s*solid\s*var\(--border-color\);"/g, 'class="flex-between align-end mb-18 pb-12 border-bottom-2"');
content = content.replace(/style="text-align:\s*right;"/g, 'class="text-right"');

content = content.replace(/style="font-size:\s*28px;\s*font-weight:\s*900;\s*line-height:\s*1;\s*color:\s*var\(--success\);"/g, 'class="font-28 font-900 text-success line-height-1"');

content = content.replace(/row\.style\.display\s*=\s*match\s*\?\s*''\s*:\s*'none';/g, "row.classList.toggle('d-none', !match);");

// Clean empty styles
content = content.replace(/\s*style=""/g, '');

fs.writeFileSync(filePath, content, 'utf8');
console.log('sales.js refactored pass 2 successfully.');
