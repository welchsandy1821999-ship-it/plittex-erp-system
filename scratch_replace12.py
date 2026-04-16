import re

js_path = r"c:\Users\Пользователь\Desktop\plittex-erp\public\js\sales.js"
with open(js_path, "r", encoding="utf-8") as f:
    text = f.read()

target = """        // Загрузка доверенностей
        setTimeout(async () => {
            try {
                const poasData = await API.get(`/api/counterparties/${order.counterparty_id}/poas`);
                const sel = document.getElementById('ship-poa-select');
                if (sel) {
                    sel.innerHTML = '<option value="">-- Выберите доверенность --</option>';
                    poasData.forEach(poa => sel.add(new Option(`${poa.driver_name} — №${poa.number} (до ${poa.expiry_date})`, `№${poa.number} (выдана: ${poa.driver_name})`)));
                }
            } catch(e) {}
        }, 50);

    } catch (e) { console.error(e); UI.toast('Ошибка', 'error'); }
};"""

replacement = """    } catch (e) { console.error(e); UI.toast('Ошибка', 'error'); }
};"""

text = text.replace(target, replacement)

with open(js_path, "w", encoding="utf-8") as f:
    f.write(text)

print("Modifications done!")
