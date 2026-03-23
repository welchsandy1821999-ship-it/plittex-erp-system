#!/bin/bash

# --- НАСТРОЙКИ ---
CONTAINER_NAME="имя_вашего_контейнера_db"  # Узнать через: docker ps
DB_NAME="имя_базы"
DB_USER="postgres"
BACKUP_DIR="/path/to/your/backups" # Куда сохранять на хосте
DAYS_TO_KEEP=7 # Сколько дней хранить бэкапы
DATE=$(date +%Y-%m-%d_%H-%M-%S)

# Создаем папку, если нет
mkdir -p $BACKUP_DIR

# --- ПРОЦЕСС ---
echo "Запуск бэкапа базы $DB_NAME..."

# Команда для Docker
docker exec -t $CONTAINER_NAME pg_dump -U $DB_USER $DB_NAME > $BACKUP_DIR/plittex_$DATE.sql

# Сжимаем (чтобы экономить место)
gzip $BACKUP_DIR/plittex_$DATE.sql

# Удаляем старые бэкапы (старше 7 дней)
find $BACKUP_DIR -type f -name "*.gz" -mtime +$DAYS_TO_KEEP -delete

echo "Бэкап готов: plittex_$DATE.sql.gz"