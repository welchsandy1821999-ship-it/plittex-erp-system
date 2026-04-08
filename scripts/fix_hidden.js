const fs = require('fs');
let c = fs.readFileSync('public/js/recipes.js', 'utf8');

// Fix recipe-editor-area
c = c.replace(
    /document\.getElementById\('recipe-editor-area'\)\.style\.display\s*=\s*'block'/g,
    "document.getElementById('recipe-editor-area').classList.remove('hidden')"
);
c = c.replace(
    /document\.getElementById\('recipe-editor-area'\)\.style\.display\s*=\s*'none'/g,
    "document.getElementById('recipe-editor-area').classList.add('hidden')"
);

// Fix recipe-summary-card
c = c.replace(
    /document\.getElementById\('recipe-summary-card'\)\.style\.display\s*=\s*'block'/g,
    "document.getElementById('recipe-summary-card').classList.remove('hidden')"
);
c = c.replace(
    /document\.getElementById\('recipe-summary-card'\)\.style\.display\s*=\s*'none'/g,
    "document.getElementById('recipe-summary-card').classList.add('hidden')"
);

fs.writeFileSync('public/js/recipes.js', c);
console.log('Fixed all hidden class toggles');
