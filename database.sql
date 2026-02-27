CREATE TABLE items (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    item_type VARCHAR(50) NOT NULL,
    unit VARCHAR(20) NOT NULL,
    current_price DECIMAL(10, 2) DEFAULT 0.00
);

CREATE TABLE counterparties (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(100),
    inn VARCHAR(20)
);

CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    amount DECIMAL(12, 2) NOT NULL,
    transaction_type VARCHAR(20) NOT NULL, 
    payment_method VARCHAR(20) NOT NULL,   
    category VARCHAR(100) NOT NULL,        
    counterparty_id INTEGER REFERENCES counterparties(id), 
    description TEXT
);

CREATE TABLE inventory_movements (
    id SERIAL PRIMARY KEY,
    movement_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    item_id INTEGER REFERENCES items(id) NOT NULL,
    quantity DECIMAL(10, 2) NOT NULL,
    movement_type VARCHAR(50) NOT NULL, 
    description TEXT
);

CREATE TABLE recipes (
    id SERIAL PRIMARY KEY,
    product_id INTEGER REFERENCES items(id) NOT NULL,
    material_id INTEGER REFERENCES items(id) NOT NULL,
    quantity_per_unit DECIMAL(10, 4) NOT NULL 
);

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL,
    full_name VARCHAR(100) NOT NULL
);

-- Таблица оборудования
CREATE TABLE equipment (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    purchase_price DECIMAL(12, 2) NOT NULL, -- Цена покупки
    service_life_months INTEGER NOT NULL,  -- Срок службы в месяцах
    current_value DECIMAL(12, 2),           -- Текущая стоимость
    status VARCHAR(50) DEFAULT 'active'     -- Работает / В ремонте
);

-- Таблица ремонтов и ТО
CREATE TABLE equipment_maintenance (
    id SERIAL PRIMARY KEY,
    equipment_id INTEGER REFERENCES equipment(id),
    maintenance_date DATE DEFAULT CURRENT_DATE,
    cost DECIMAL(12, 2) NOT NULL,
    description TEXT
);