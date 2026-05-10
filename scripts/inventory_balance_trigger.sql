CREATE OR REPLACE FUNCTION check_warehouse_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_item_id bigint;
    v_warehouse_id bigint;
    v_available numeric;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    /* Обновление только цен/прочих полей без смены пары товар–склад–количество: не перепроверяем остаток
       (иначе backfill unit_price и правки метаданных падают на исторически «минусовых» списаниях). */
    IF TG_OP = 'UPDATE' THEN
        IF OLD.item_id IS NOT DISTINCT FROM NEW.item_id
           AND OLD.warehouse_id IS NOT DISTINCT FROM NEW.warehouse_id
           AND OLD.quantity IS NOT DISTINCT FROM NEW.quantity
        THEN
            RETURN NEW;
        END IF;
    END IF;

    IF NEW.quantity IS NULL OR NEW.quantity >= 0 THEN
        RETURN NEW;
    END IF;

    v_item_id := NEW.item_id;
    v_warehouse_id := NEW.warehouse_id;

    IF v_item_id IS NULL OR v_warehouse_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(SUM(im.quantity), 0)
      INTO v_available
      FROM inventory_movements im
     WHERE im.item_id = v_item_id
       AND im.warehouse_id = v_warehouse_id
       AND (
            TG_OP <> 'UPDATE'
            OR im.id <> OLD.id
       );

    IF v_available + NEW.quantity < 0 THEN
        RAISE EXCEPTION
            'Недостаточно остатка на складе: item_id=%, warehouse_id=%, доступно=%, попытка списания=%, итог=%',
            v_item_id, v_warehouse_id, v_available, abs(NEW.quantity), v_available + NEW.quantity
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_balance_trigger ON inventory_movements;

CREATE TRIGGER inventory_balance_trigger
BEFORE INSERT OR UPDATE OF item_id, warehouse_id, quantity
ON inventory_movements
FOR EACH ROW
EXECUTE FUNCTION check_warehouse_balance();
