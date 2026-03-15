#!/bin/bash
# Настройки
BACKUP_DIR="/user/db_backups"
DB_NAME="plittex_erp"
DB_USER="postgres"
DATE=$(date +"%Y-%m-%d_%H-%M")

# Создаем папку, если ее нет
mkdir -p $BACKUP_DIR

# Выполняем дамп внутри контейнера базы данных (убедись, что контейнер называется plittex-erp-db-1)
docker exec plittex-erp-db-1 pg_dump -U $DB_USER $DB_NAME > $BACKUP_DIR/${DB_NAME}_${DATE}.sql

# Удаляем бэкапы старше 14 дней, чтобы не забивать диск
find $BACKUP_DIR -type f -name "*.sql" -mtime +14 -exec rm {} \;