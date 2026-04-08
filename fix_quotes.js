const fs = require('fs');
let C = fs.readFileSync('public/js/recipes.js', 'utf8');

// The line: onclick="executeSaveRecipe(${productId}, '${productName}', true)"
// has a bug where if productName contains " it prematurely ends the tag attribute onclick="..."

C = C.replace(/onclick="executeSaveRecipe\(\$\{productId\}, '\$\{productName\}', true\)"/g, 'onclick="saveRecipe(true)"');
C = C.replace(/onclick="executeSaveRecipe\(\$\{productId\}, '\$\{productName\}', \$\{force\}\)"/g, 'onclick="saveRecipe(true)"');

fs.writeFileSync('public/js/recipes.js', C);
console.log('Fixed quotes syntax bug');
