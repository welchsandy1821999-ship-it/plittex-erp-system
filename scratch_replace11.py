import re

js_path = r"c:\Users\Пользователь\Desktop\plittex-erp\public\js\sales.js"
with open(js_path, "r", encoding="utf-8") as f:
    text = f.read()

target = """                            <select id="ship-poa-select" class="input-modern"></select>
                            
                            <label class="d-flex align-center cursor-pointer m-0 mt-5">"""

replacement = """                            <div class="flex-row gap-10">
                                <select id="ship-poa-select" class="input-modern flex-grow-1"></select>
                                <button type="button" class="btn btn-outline" style="padding: 0 15px;" onclick="openPoaManager(${order.counterparty_id}, 'ship-poa-select')">➕ Новая</button>
                            </div>
                            
                            <label class="d-flex align-center cursor-pointer m-0 mt-5">"""

text = text.replace(target, replacement)

target2 = """        UI.showModal(`Управление заказом: ${order.doc_number}`, html, `
            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom: 15px;">
                <button class="btn btn-outline flex-grow-1" onclick="generateInvoice(${order.id})">📄 Счет на оплату</button>
                <button class="btn btn-outline flex-grow-1" onclick="generateSpec(${order.id})">📄 Приложение / Специф.</button>
            </div>
            <div style="display:flex; justify-content:space-between; width:100%;">
                <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
                <button class="btn btn-success" onclick="executeShipment(${order.id})">🚀 Оформить отгрузку</button>
            </div>
        `);
    } catch (e) {"""

replacement2 = """        UI.showModal(`Управление заказом: ${order.doc_number}`, html, `
            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom: 15px;">
                <button class="btn btn-outline flex-grow-1" onclick="generateInvoice(${order.id})">📄 Счет на оплату</button>
                <button class="btn btn-outline flex-grow-1" onclick="generateSpec(${order.id})">📄 Приложение / Специф.</button>
            </div>
            <div style="display:flex; justify-content:space-between; width:100%;">
                <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
                <button class="btn btn-success" onclick="executeShipment(${order.id}, ${order.counterparty_id})">🚀 Оформить отгрузку</button>
            </div>
        `);

        // Load POAs correctly since modal is shown
        setTimeout(() => {
            if (typeof loadClientPoas === 'function') {
                loadClientPoas(order.counterparty_id, 'ship-poa-select');
            }
        }, 100);

    } catch (e) {"""

text = text.replace(target2, replacement2)

with open(js_path, "w", encoding="utf-8") as f:
    f.write(text)

print("Modifications done!")
