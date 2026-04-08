const fs = require('fs');
let C = fs.readFileSync('public/js/recipes.js', 'utf8');
C = C.split('const productName = prodSelect.options[prodSelect.selectedIndex].text;').join("const tsP = prodSelect.tomselect; const productName = tsP ? (tsP.options[tsP.getValue()] ? tsP.options[tsP.getValue()].text : '') : (prodSelect.options[prodSelect.selectedIndex] ? prodSelect.options[prodSelect.selectedIndex].text : '');");
fs.writeFileSync('public/js/recipes.js', C);
