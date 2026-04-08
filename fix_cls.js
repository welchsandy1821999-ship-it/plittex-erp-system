const fs = require('fs');
let content = fs.readFileSync('views/modules/recipes.ejs', 'utf8');

// A simple regex to catch `<tag ... class="A" ... class="B" ...>`
// Actually, let's just make specific target replacements based on known errors:

content = content.replace(/class="flex-between mb-20"\s+class="align-end"/g, 'class="flex-between mb-20 align-end"');
content = content.replace(/class="card"\s+class="border-primary-left hidden"/g, 'class="card border-primary-left hidden"');
content = content.replace(/class="card card-alt"\s+id="recipe-summary-card"\s+class="hidden"/g, 'class="card card-alt hidden" id="recipe-summary-card"');
content = content.replace(/class="card card-recipe-editor"\s+id="recipe-editor-area"\s+class="hidden"/g, 'class="card card-recipe-editor hidden" id="recipe-editor-area"');
content = content.replace(/class="btn btn-blue shadow-primary"\s+class="font-bold radius-8 p-12-24"/g, 'class="btn btn-blue shadow-primary font-bold radius-8 p-12-24"');
content = content.replace(/class="flex-between mb-20"\s+class="align-center pb-20 border-bottom-dashed"/g, 'class="flex-between mb-20 align-center pb-20 border-bottom-dashed"');
content = content.replace(/class="mt-0 text-main"\s+class="mb-0 font-20"/g, 'class="mt-0 text-main mb-0 font-20"');
content = content.replace(/class="badge"\s+class="hidden p-6-12 font-13 font-bold radius-6"/g, 'class="badge hidden p-6-12 font-13 font-bold radius-6"');
content = content.replace(/class="btn btn-blue shadow-primary"\s+onclick="addIngredientToRecipe\(\)"\s+class="h-42 px-25"/g, 'class="btn btn-blue shadow-primary h-42 px-25" onclick="addIngredientToRecipe()"');
content = content.replace(/class="text-center text-muted"\s+class="hidden p-20 font-14 border-dashed radius-6 mt-15"/g, 'class="text-center text-muted hidden p-20 font-14 border-dashed radius-6 mt-15"');

// Wait, I noticed L97: `<div id="mix-yield-container" class="hidden bg-surface p-12 radius-8 border-dashed mt-15">`
// This one only has ONE class attribute now because it had no other classes before? Wait, no, look at L97 in my view_file output:
// <div id="mix-yield-container" class="hidden bg-surface p-12 radius-8 border-dashed mt-15">
// Yes, it only has one! It used to be `<div id="mix-yield-container" style="...">`

// Wait, L12: `<div class="mb-20 rec-filter-container">` - 1 class, OK
// L21: `<p class="text-muted font-13 m-0">` - 1 class, OK
// L28: `<div class="card pl-10 rec-section-title" id="recipe-left-mode-bom">` - 1 class, OK
// L127: `<div class="add-component-box rec-cost-panel">` - 1 class, OK
// L130: `<div class="form-group flex-2 min-w-200 m-0">` - 1 class, OK
// L134: `<div class="form-group flex-1 min-w-120 m-0">` - 1 class, OK

fs.writeFileSync('views/modules/recipes.ejs', content, 'utf8');
console.log('Fixed double classes explicitly');
