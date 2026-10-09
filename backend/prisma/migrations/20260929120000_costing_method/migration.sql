-- Метод списания — настройка компании (ТЗ 5.7).
--
-- Значение по умолчанию FIFO: так система считала до этой настройки, и смена
-- умолчания переписала бы себестоимость уже отгруженного. Перечисление, а не
-- строка: «фифо», «ФИФО» и «fifo» в одном столбце означали бы, что метод
-- решает тот, кто последним заполнял форму.
CREATE TYPE "CostingMethod" AS ENUM ('fifo', 'weighted_average');

ALTER TABLE company
  ADD COLUMN costing_method "CostingMethod" NOT NULL DEFAULT 'fifo';
