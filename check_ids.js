const fs = require('fs');
const js = fs.readFileSync('public/js/recipes.js', 'utf8');
const ejs = fs.readFileSync('views/modules/recipes.ejs', 'utf8');
const regex = /getElementById\(['"]([^'"]+)['"]\)/g;
let match;
const ids = new Set();
while ((match = regex.exec(js)) !== null) {
  ids.add(match[1]);
}
const missing = [...ids].filter(id => !ejs.includes(`id="${id}"`) && !ejs.includes(`id='${id}'`));
console.log('Missing IDs:', missing);
