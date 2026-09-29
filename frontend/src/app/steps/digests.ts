/* Сводки блоков шага 5 из ответов сервера: одно-три числа и строка вывода для строки-сводки.
   Ничего не пересчитываем: берем окупаемость и счетчики, как их прислал сервер, и выбираем, что
   показать. Срок форматирует вызывающий (term из format.ts), чтобы модуль проверялся без браузера */

export type Fact = { label: string; value: string; unit?: string };
export type Brief = { facts: Fact[]; line: string };

type Term = (years: number | null | undefined) => string;

/* Что будет, если: то же, что таблица блока. Ячейка без базовой стоимости владения значит "парк
   не сходится", ячейка без окупаемости значит "не окупается" */
type WhatIf = {
  params: {
    id: string;
    name: string;
    cells: {
      delta: number;
      baseline_tco_rub: number | null;
      outcomes: { scenario_id: string; payback_years: number | null }[];
    }[];
  }[];
};

// "Зарплаты" в середине строки со строчной, а "WMS" и "Wi-Fi" как есть: в первом слове есть еще заглавные
const lower = (text: string) =>
  /[A-ZА-Я]/.test(text.split(" ")[0].slice(1)) ? text : text.charAt(0).toLowerCase() + text.slice(1);
const shift = (delta: number) => `${delta > 0 ? "+" : "-"}${Math.round(Math.abs(delta) * 100)}%`;

export function whatIfBrief(data: WhatIf | null, scenario: string, term: Term): Brief {
  if (!data) return { facts: [], line: "Считаем варианты..." };
  const cells = data.params
    // плата за аренду покупку не меняет, в таблице этой строки у покупки тоже нет
    .filter((param) => !(scenario === "purchase" && param.id === "raas_fee"))
    .flatMap((param) =>
      param.cells.map((cell) => ({
        name: param.name,
        delta: cell.delta,
        fits: cell.baseline_tco_rub !== null,
        years: cell.outcomes.find((one) => one.scenario_id === scenario)?.payback_years ?? null,
      })),
    );
  const counted = cells.filter((cell) => cell.fits && cell.years !== null) as {
    name: string;
    delta: number;
    years: number;
  }[];
  if (!counted.length) return { facts: [], line: "Сдвиги на 10 и 20%: окупаемость не посчиталась" };
  const best = counted.reduce((a, b) => (b.years < a.years ? b : a));
  const worst = counted.reduce((a, b) => (b.years > a.years ? b : a));
  const facts = [
    { label: "окупаемость от", value: term(best.years) },
    { label: "до", value: term(worst.years) },
  ];
  // худший сдвиг ближе к нынешним числам важнее: -10% объема вероятнее, чем -20%
  const nearest = <T extends { delta: number }>(list: T[]) =>
    list.reduce<T | null>((a, b) => (a === null || Math.abs(b.delta) < Math.abs(a.delta) ? b : a), null);
  const broken = nearest(cells.filter((cell) => !cell.fits));
  if (broken) return { facts, line: `Парк не справится: ${lower(broken.name)} ${shift(broken.delta)}` };
  const lost = nearest(cells.filter((cell) => cell.years === null));
  if (lost) return { facts, line: `Не окупится: ${lower(lost.name)} ${shift(lost.delta)}` };
  if (worst.delta === 0 || best.years === worst.years)
    return { facts, line: "Сдвиги на 10 и 20% окупаемость почти не меняют" };
  return { facts, line: `Хуже всего: ${lower(worst.name)} ${shift(worst.delta)}. Сдвиги на 10 и 20%` };
}

/* Что подготовить на складе: три счетчика и первый пункт, который переделать или проверить */
type Readiness = {
  items: { title: string; status: string }[];
  counts: Record<string, number>;
};

export function readinessBrief(data: Readiness | null): Brief {
  if (!data) return { facts: [], line: "Собираем список..." };
  const redo = data.items.find((item) => item.status === "redo");
  const check = data.items.find((item) => item.status === "check");
  return {
    facts: [
      { label: "переделать", value: String(data.counts.redo ?? 0) },
      { label: "проверить", value: String(data.counts.check ?? 0) },
      { label: "готово", value: String(data.counts.ready ?? 0) },
    ],
    line: redo
      ? `Первым переделать: ${lower(redo.title)}`
      : check
        ? `Первым проверить: ${lower(check.title)}`
        : "Все готово к роботам",
  };
}
