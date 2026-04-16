import re

path = r"c:\Users\Пользователь\Desktop\plittex-erp\public\js\inventory.js"

with open(path, "r", encoding="utf-8") as f:
    text = f.read()

target = """                score: function (search) {
                    if (!search) return function() { return 1; };
                    var score = this.getScoreFunction(search);
                    return function (item) {
                        var baseScore = score(item);
                        if (search) {
                            var queryCondensed = search.toLowerCase().replace(/[\\.\\s-]/g, '');
                            var textCondensed = (item.text || '').toLowerCase().replace(/[\\.\\s-]/g, '');
                            if (queryCondensed.length >= 2 && textCondensed.includes(queryCondensed)) {
                                baseScore += 1000;
                            }
                        }
                        return baseScore;
                    };
                },"""

replacement = """                score: function(search) {
                    if (!search) return function() { return 1; };

                    const query = search.toLowerCase();
                    const queryCondensed = query.replace(/[\\.\\s-]/g, '');
                    const tokens = query.split(/\\s+/).filter(Boolean);
                    
                    return function(item) {
                        const text = (item.text || '').toLowerCase();
                        const textCondensed = text.replace(/[\\.\\s-]/g, '');
                        
                        let multiTargetMatch = true;
                        for (let token of tokens) {
                            let tokenCondensed = token.replace(/[\\.\\s-]/g, '');
                            if (!text.includes(token) && (!tokenCondensed || !textCondensed.includes(tokenCondensed))) {
                                multiTargetMatch = false;
                                break;
                            }
                        }

                        if (!multiTargetMatch) {
                            if (queryCondensed.length < 2 || !textCondensed.includes(queryCondensed)) {
                                return 0;
                            }
                        }
                        
                        let baseScore = 100 / (text.length + 1);
                        
                        if (queryCondensed.length >= 2 && textCondensed.includes(queryCondensed)) {
                            baseScore += 1000;
                        }
                        
                        return baseScore; 
                    };
                },"""

new_text = text.replace(target, replacement)

if new_text != text:
    with open(path, "w", encoding="utf-8") as f:
        f.write(new_text)
    print("Success! Score algorithm fixed.")
else:
    print("Failed to replace string. Trying regex fallback")
    def normalize_spaces(s):
        return re.sub(r'\s+', ' ', s).strip()
    pat = re.escape(normalize_spaces(target)).replace(r'\ ', r'\s+')
    if re.search(pat, text):
        new_text = re.sub(pat, replacement, text, count=1)
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_text)
        print("Success! Replaced via regex.")
    else:
        print("Target absolutely not found!!!")
