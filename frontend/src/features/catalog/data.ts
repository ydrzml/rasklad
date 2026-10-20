import { api } from "../../api/client";
import { buildCatalog, type Catalog } from "./items";

// Каталог для гостя собирается из тех же открытых точек, что читает мастер: склад по каждой задаче
// (/api/catalog/solutions), аэропорт и медучреждение одним запросом на все задачи
// (/api/catalog/facility-solutions)
export async function loadCatalog(signal: AbortSignal): Promise<Catalog> {
  const facilities = await api.facilities();
  const warehouse = facilities.find((one) => one.id === "warehouse");
  const listed = facilities.filter((one) => one.status === "solutions");
  const [stock, others] = await Promise.all([
    Promise.all((warehouse?.operations ?? []).map((task) => api.solutions("warehouse", task.id))),
    Promise.all(
      listed.map((one) =>
        api.facilitySolutions(
          { facility_id: one.id, operation_ids: one.operations.map((task) => task.id), overrides: {} },
          signal,
        ),
      ),
    ),
  ]);
  return buildCatalog(facilities, stock, others);
}
