const fs = require('fs');
let C = fs.readFileSync('public/js/recipes.js', 'utf8');
C = C.replace(/class="text-main"\s+class="font-15"/g, 'class="text-main font-15"');
C = C.replace(/class="mb-5"\s+class="font-500"/g, 'class="mb-5 font-500"');
C = C.replace(/class="form-group min-w-100"\s+class="m-0 flex-1"/g, 'class="form-group min-w-100 m-0 flex-1"');
C = C.replace(/class="form-group"\s+class="m-0 flex-1"/g, 'class="form-group m-0 flex-1"');
fs.writeFileSync('public/js/recipes.js', C);
console.log('Fixed js strings');
