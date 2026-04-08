const fs = require('fs');
let content = fs.readFileSync('public/js/recipes.js', 'utf8');

// Replace standard document.getElementById(...).style.display
content = content.replace(/document\.getElementById\('tab-recipes-bom'\)\.style\.color = mode === 'BOM' \? '' : 'var\(--primary\)';/g, 
"document.getElementById('tab-recipes-bom').classList.toggle('rec-primary-outline', mode !== 'BOM');\ndocument.getElementById('tab-recipes-bom').classList.toggle('btn-blue', mode === 'BOM');\ndocument.getElementById('tab-recipes-bom').classList.toggle('shadow-primary', mode === 'BOM');\ndocument.getElementById('tab-recipes-bom').classList.toggle('btn-outline', mode !== 'BOM');");

content = content.replace(/document\.getElementById\('tab-recipes-mix'\)\.style\.color = mode === 'MIX' \? '' : 'var\(--primary\)';/g, 
"document.getElementById('tab-recipes-mix').classList.toggle('rec-primary-outline', mode !== 'MIX');\ndocument.getElementById('tab-recipes-mix').classList.toggle('btn-blue', mode === 'MIX');\ndocument.getElementById('tab-recipes-mix').classList.toggle('shadow-primary', mode === 'MIX');\ndocument.getElementById('tab-recipes-mix').classList.toggle('btn-outline', mode !== 'MIX');");

content = content.replace(/document\.getElementById\('recipe-left-mode-bom'\)\.style\.display = mode === 'BOM' \? 'block' : 'none';/g, 
"document.getElementById('recipe-left-mode-bom').classList.toggle('hidden', mode !== 'BOM');");

content = content.replace(/document\.getElementById\('recipe-left-mode-mix'\)\.style\.display = mode === 'MIX' \? 'block' : 'none';/g, 
"document.getElementById('recipe-left-mode-mix').classList.toggle('hidden', mode !== 'MIX');");

content = content.replace(/document\.getElementById\('recipe-editor-area'\)\.style\.display = 'none';/g, 
"document.getElementById('recipe-editor-area').classList.add('hidden');");

content = content.replace(/document\.getElementById\('recipe-summary-card'\)\.style\.display = 'none';/g, 
"document.getElementById('recipe-summary-card').classList.add('hidden');");

content = content.replace(/document\.getElementById\('mix-yield-container'\)\.style\.display = mode === 'MIX' \? 'block' : 'none';/g, 
"document.getElementById('mix-yield-container').classList.toggle('hidden', mode !== 'MIX');");

content = content.replace(/if \(massApplyBtn\) massApplyBtn\.style\.display = mode === 'BOM' \? 'block' : 'none';/g, 
"if (massApplyBtn) massApplyBtn.classList.toggle('hidden', mode !== 'BOM');");

content = content.replace(/if \(topMassApplyPanel\) topMassApplyPanel\.style\.display = mode === 'BOM' \? 'flex' : 'none';/g, 
"if (topMassApplyPanel) topMassApplyPanel.classList.toggle('hidden', mode !== 'BOM');");

content = content.replace(/document\.getElementById\('recipe-editor-badge'\)\.style\.display = 'none';/g, 
"document.getElementById('recipe-editor-badge').classList.add('hidden');");

content = content.replace(/document\.getElementById\('recipe-editor-area'\)\.style\.display = 'block';/g, 
"document.getElementById('recipe-editor-area').classList.remove('hidden');");

content = content.replace(/document\.getElementById\('recipe-summary-card'\)\.style\.display = 'block';/g, 
"document.getElementById('recipe-summary-card').classList.remove('hidden');");

content = content.replace(/if\(el\) el\.style\.display = el\.style\.display === 'none' \|\| el\.style\.display === '' \? 'grid' : 'none';/g, 
"if(el) el.classList.toggle('hidden');");

content = content.replace(/document\.getElementById\('recipe-empty-msg'\)\.style\.display = 'block';/g, 
"document.getElementById('recipe-empty-msg').classList.remove('hidden');");

content = content.replace(/document\.getElementById\('recipe-empty-msg'\)\.style\.display = 'none';/g, 
"document.getElementById('recipe-empty-msg').classList.add('hidden');");

content = content.replace(/el\.style\.display = 'none'/g, "el.classList.add('hidden')");

fs.writeFileSync('public/js/recipes.js', content, 'utf8');
console.log('Fixed JS!');
