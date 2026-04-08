const fs = require('fs');
let C = fs.readFileSync('views/modules/recipes.ejs', 'utf8');

// Find existing script tag regardless of query param
C = C.replace(/<script src="\/js\/recipes\.js(\?v=\d+)?"><\/script>/g, '<script src="/js/recipes.js?v=' + Date.now() + '"></script>');

fs.writeFileSync('views/modules/recipes.ejs', C);
console.log("Cache busted successfully");
