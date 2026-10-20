import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClinicRobots, FacilitySolution } from "../src/api/client.ts";
import { UNFIT, clinicChoices, selectionProblem, unfitReason } from "../src/app/clinic/selection.ts";

const solution = (changes: Partial<FacilitySolution> = {}): FacilitySolution =>
  ({
    id: "delivery",
    operation: "floor_delivery",
    status: "recommended",
    checks: [],
    price_rub: 1_000_000,
    ...changes,
  }) as FacilitySolution;
const robots: ClinicRobots = {
  delivery: [{ id: "delivery", product: "Доставщик", operation: "floor_delivery", missing: [], speed_m_s: 1 }],
  cleaning: [{ id: "cleaner", product: "Уборщик", operation: "cleaning", missing: [], speed_m_s: 1 }],
};

test("восстановленный выбор учитывает задачу и доступность модели, не подставляя робота по умолчанию", () => {
  const delivery = solution();
  const cleaner = solution({ id: "cleaner", operation: "cleaning" });
  assert.deepEqual(
    clinicChoices(
      ["floor_delivery", "cleaning"],
      { floor_delivery: "delivery", cleaning: "cleaner" },
      [delivery, cleaner],
      robots,
    ),
    { floor_delivery: "delivery", cleaning: "cleaner" },
  );
  assert.deepEqual(clinicChoices(["cleaning"], { cleaning: "delivery" }, [delivery, cleaner], robots), {});
  assert.deepEqual(clinicChoices(["floor_delivery"], { floor_delivery: "removed" }, [delivery], robots), {});
  assert.deepEqual(clinicChoices(["floor_delivery"], { floor_delivery: "delivery" }, [delivery], null), {});
});

test("робот без данных, цены или с блокирующей проверкой не становится готовым выбором", () => {
  const incomplete = { ...robots, delivery: [{ ...robots.delivery[0], missing: ["charge_time_h"] }] };
  assert.match(selectionProblem(solution(), incomplete)!, /время зарядки/);
  assert.match(selectionProblem(solution({ price_rub: null }), robots)!, /Нет цены/);
  assert.match(selectionProblem(solution({ status: "excluded" }), robots)!, /Не подходит/);
  assert.match(selectionProblem(solution({ operation: "disinfection" }), robots)!, /нет расчетной модели/);
});

test("робот, которому корпус не подходит, уходит в 'Требуют проверки' с причиной сервера и не выбирается", () => {
  const cleaner = solution({ id: "cleaner", operation: "cleaning" });
  const fit = { delivery: {}, cleaning: { cleaner: "Не выезжает с базы ни на одном этаже. Проезд 1300 мм" } };
  assert.equal(selectionProblem(cleaner, robots, fit), UNFIT);
  assert.match(unfitReason(cleaner, fit)!, /1300 мм/);
  assert.equal(unfitReason(solution(), fit), null);
  assert.deepEqual(clinicChoices(["cleaning"], { cleaning: "cleaner" }, [cleaner], robots, fit), {});
  assert.equal(selectionProblem(cleaner, robots, null), null);
});

test("проверки без блокировки разрешают выбирать робота с полными данными", () => {
  assert.equal(selectionProblem(solution({ status: "needs_check" }), robots), null);
});
