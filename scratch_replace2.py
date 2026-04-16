import re

path = r"c:\Users\Пользователь\Desktop\plittex-erp\public\js\inventory.js"

with open(path, "r", encoding="utf-8") as f:
    text = f.read()

target = """    const searchSource = window.globalItemsList.length ? window.globalItemsList : allInventory;
    
    // Инициализация TomSelect "умного поиска" для смены товара (как в Формовке)
    const switchEl = document.getElementById('history-item-switch');
    if (switchEl) {
        if (!switchEl.tomselect) {
            new TomSelect(switchEl, {
                create: false,
                dropdownParent: 'body',
                sortField: { field: "text", direction: "asc" },
                maxOptions: null,
                placeholder: "🔍 Введите товар...",
                score: function (search) {
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
                },
                render: {
                    option: function (data, escape) {
                        return '<div class="ts-option-product"><span class="ts-product-name">' + escape(data.text || '') + '</span></div>';
                    },
                    item: function (data, escape) {
                        return '<div>' + escape(data.text || '') + '</div>';
                    }
                },
                onDropdownOpen: function (dropdown) {
                    var content = dropdown.querySelector('.ts-dropdown-content');
                    var selected = content && content.querySelector('.active, .selected');
                    if (selected && content) {
                        setTimeout(function () {
                            if (content.scrollTop !== undefined) {
                                content.scrollTop = selected.offsetTop - (content.clientHeight / 2) + (selected.clientHeight / 2);
                            }
                        }, 0);
                    }
                }
            });
        }
        
        const ts = switchEl.tomselect;
        ts.clearOptions();
        const options = searchSource.map(inv => ({
            value: inv.name || inv.item_name || '',
            text: inv.name || inv.item_name || ''
        })).filter(o => o.value !== '');
        ts.addOptions(options);

        // Установка заголовка и значения в селект
        const itemObj = searchSource.find(i => String(i.id || i.item_id) === String(itemId));
        if (itemObj) {
            const dispName = itemObj.name || itemObj.item_name || '';
            document.getElementById('history-modal-title').innerText = "Карточка движения: " + dispName;
            ts.setValue(dispName, true);
        } else {
            document.getElementById('history-modal-title').innerText = "Карточка движения";
            ts.setValue("", true);
        }
        
        // Force refresh to make sure dropdown options render properly
        ts.refreshOptions(false);
    }"""

def normalize_spaces(s):
    return re.sub(r'\s+', ' ', s).strip()

def escape_regex(s):
    return re.escape(s).replace(r'\ ', r'\s+')

pattern = escape_regex(normalize_spaces("""    const searchSource = window.globalItemsList.length ? window.globalItemsList : allInventory;
    
    // Инициализация TomSelect "умного поиска" для смены товара (как в Формовке)
    const switchEl = document.getElementById('history-item-switch');
    if (switchEl) {
        if (!switchEl.tomselect) {
            new TomSelect(switchEl, {
                create: false,
                dropdownParent: 'body',
                sortField: { field: "text", direction: "asc" },
                maxOptions: null,
                placeholder: "🔍 Введите товар...",
                score: function (search) {
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
                            if (content.scrollTop !== undefined) {
                                content.scrollTop = selected.offsetTop - (content.clientHeight / 2) + (selected.clientHeight / 2);
                            }
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
    }"""))

new_text = re.sub(pattern, target, text, count=1)
if new_text != text:
    with open(path, "w", encoding="utf-8") as f:
        f.write(new_text)
    print("Success! Replaced.")
else:
    print("Could not find Target in file.")

