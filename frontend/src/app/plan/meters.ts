/* Метры на листе. Показываем до 0,1 м с запятой, как везде в интерфейсе: «10,4 × 10 м».
   Храним до сантиметра: ряды толщиной 2,2 м и прилипание к соседям складывают дроби, и без
   округления в плане копился хвост вроде 10.399999999999991. Проверка: tests/meters.test.ts */
import type { Plan } from "../../api/client";

/* 10.399999999999991 -> 10.4: число для поля в окне свойств, пока его не правят */
export function tenth(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

/* 10.399999999999991 -> «10,4», 12 -> «12», -0.04 -> «0» */
export function meters(value: number): string {
  return String(tenth(value)).replace(".", ",");
}

/* Число, которое кладем в план: до сантиметра */
export function snapM(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/* План с координатами до сантиметра: вещи, секции и точки контуров. Правка идет через него,
   поэтому хвост дроби не доходит ни до сервера, ни до подписей */
export function tidyPlan(plan: Plan): Plan {
  return {
    ...plan,
    items: plan.items.map((one) => ({ ...one, x: snapM(one.x), y: snapM(one.y), w: snapM(one.w), h: snapM(one.h) })),
    sections: plan.sections.map((one) => ({
      ...one,
      x: snapM(one.x),
      y: snapM(one.y),
      w: snapM(one.w),
      h: snapM(one.h),
      points: (one.points ?? []).map(([x, y]) => [snapM(x), snapM(y)] as [number, number]),
    })),
  };
}
