const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'js', 'sales.js');
let content = fs.readFileSync(filePath, 'utf8');

// padding limits
content = content.replace(/style="padding:\s*12px\s*15px;"/g, 'class="p-12-15"');
content = content.replace(/style="padding:\s*10px;"/g, 'class="p-10"');
content = content.replace(/style="padding:\s*15px;"/g, 'class="p-15"');
content = content.replace(/style="margin-bottom:\s*20px;"/g, 'class="mb-20"');
content = content.replace(/style="margin-bottom:\s*15px;"/g, 'class="mb-15"');
content = content.replace(/style="text-align:\s*center;"/g, 'class="text-center"');

// specific cases
content = content.replace(/style="display:\s*flex;\s*gap:\s*15px;"/g, 'class="d-flex gap-15"');
content = content.replace(/style="max-height:\s*350px;"/g, 'class="max-h-350p"');
content = content.replace(/style="display:none"/g, 'class="d-none"');
content = content.replace(/style="display:none;"/g, 'class="d-none"');

content = content.replace(/\s*style=""/g, '');

fs.writeFileSync(filePath, content, 'utf8');
console.log('sales.js refactored pass 3 successfully.');
