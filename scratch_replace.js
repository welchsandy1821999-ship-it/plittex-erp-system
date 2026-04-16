const fs = require('fs');
const path = 'c:\\Users\\Пользователь\\Desktop\\plittex-erp\\public\\js\\inventory.js';
let content = fs.readFileSync(path, 'utf8');

const targetStr = `    const datalist = document.getElementById('history-item-datalist');
    const searchSource = window.globalItemsList.length ? window.globalItemsList : allInventory;
    if (datalist) {
        datalist.innerHTML = '';
        searchSource.forEach(inv => {
            datalist.innerHTML += \`<option value="\${Utils.escapeHtml(inv.name || inv.item_name)}"></option>\`;
        });
    }
    
    // Установка заголовка
    const itemObj = searchSource.find(i => String(i.id || i.item_id) === String(itemId));
    if (itemObj) {
        document.getElementById('history-modal-title').innerText = "Карточка движения: " + (itemObj.name || itemObj.item_name);
        const searchInput = document.getElementById('history-item-switch');
        if (searchInput) searchInput.value = itemObj.name || itemObj.item_name;
    } else {
        document.getElementById('history-modal-title').innerText = "Карточка движения";
    }`;

const replaceStr = `    const searchSource = window.globalItemsList.length ? window.globalItemsList : allInventory;
    
    // Инициализация TomSelect "умного поиска" для смены товара (как в Формовке)
    const switchEl = document.getElementById('history-item-switch');
    if (switchEl) {
        if (!switchEl.tomselect) {
            new TomSelect(switchEl, {
                create: false,
                sortField: { field: "text", direction: "asc" },
                maxOptions: null,
                placeholder: "🔍 Введите товар...",
                score: function (search) {
                    var score = this.getScoreFunction(search);
                    return function (item) {
                        var baseScore = score(item);
                        if (search) {
                            var queryCondensed = search.toLowerCase().replace(/[\\.\\s-]/g, '');
                            var textCondensed = item.text.toLowerCase().replace(/[\\.\\s-]/g, '');
                            if (queryCondensed.length >= 2 && textCondensed.includes(queryCondensed)) {
                                baseScore += 1000;
                            }
                        }
                        return baseScore;
                    };
                },
                render: {
                    option: function (data, escape) {
                        return '<div class="ts-option-product"><span class="ts-product-name">' + escape(data.text) + '</span></div>';
                    },
                    item: function (data, escape) {
                        return '<div>' + escape(data.text) + '</div>';
                    }
                },
                onDropdownOpen: function (dropdown) {
                    var content = dropdown.querySelector('.ts-dropdown-content');
                    var selected = content && content.querySelector('.active, .selected');
                    if (selected && content) {
                        setTimeout(function () {
                            content.scrollTop = selected.offsetTop - (content.clientHeight / 2) + (selected.clientHeight / 2);
                        }, 0);
                    }
                }
            });
        }
        
        const ts = switchEl.tomselect;
        ts.clearOptions();
        const options = searchSource.map(inv => ({
            value: inv.name || inv.item_name,
            text: inv.name || inv.item_name
        }));
        ts.addOptions(options);

        // Установка заголовка и значения в селект
        const itemObj = searchSource.find(i => String(i.id || i.item_id) === String(itemId));
        if (itemObj) {
            document.getElementById('history-modal-title').innerText = "Карточка движения: " + (itemObj.name || itemObj.item_name);
            ts.setValue(itemObj.name || itemObj.item_name, true);
        } else {
            document.getElementById('history-modal-title').innerText = "Карточка движения";
            ts.setValue("", true);
        }
    }`;

// Normalize line endings for replacement mapping
const normalize = str => str.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
content = normalize(content);

if (content.includes(normalize(targetStr))) {
    content = content.replace(normalize(targetStr), replaceStr);
    fs.writeFileSync(path, content, 'utf8');
    console.log("SUCCESS!");
} else {
    console.log("FAILED to find target string in inventory.js");
}
