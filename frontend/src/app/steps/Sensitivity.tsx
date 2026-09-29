import { useEffect, useState } from "react";

import { api, type CalculationRequest, type SensitivityAll, type SensitivityResult } from "../../api/client";
import { Alert, BlockHead, Button, Tornado, WhatIf, type TornadoRow } from "../../ui";
import { mln, number, term } from "../format";
import { plural } from "./economicsNames";

// Размах меньше 50 тысяч рублей на экране выглядит как 0,0 млн: такие числа итог не двигают
const NOTICEABLE = 50_000;

/* Что будет, если главные числа окажутся другими (ТЗ, п. 3.5.6). Считает сервер: одно число
   сдвигается на 10 и 20% в обе стороны, остальные стоят. Парк из того же прогона смены, поэтому
   ответ приходит быстро: прогон уже посчитан */
export function Sensitivity({
  request,
  scenario,
  version,
  onBrief,
}: {
  request: CalculationRequest;
  /* сценарий из сводки: покупка или аренда */
  scenario: string;
  /* меняется, когда пришел новый расчет: тогда и чувствительность считаем заново */
  version: unknown;
  /* ответ сервера наверх: из него сводка в карточке */
  onBrief?: (data: SensitivityResult) => void;
}) {
  const [data, setData] = useState<SensitivityResult | null>(null);
  const [error, setError] = useState("");
  // все числа по силе влияния: считаем только по кнопке, это около секунды на сервере
  const [open, setOpen] = useState(false);
  // ответ помним вместе с расчетом, к которому он относится: после нового расчета старый не показываем
  const [answered, setAnswered] = useState<{ version: unknown; data: SensitivityAll } | null>(null);
  const all = answered && answered.version === version ? answered.data : null;
  const [allError, setAllError] = useState("");

  useEffect(() => {
    const abort = new AbortController();
    api
      .sensitivity(request, abort.signal)
      .then((answer) => {
        setData(answer);
        onBrief?.(answer);
        setError("");
      })
      .catch((failure: Error) => {
        if (failure.name !== "AbortError") setError(`Не посчиталось: ${failure.message}`);
      });
    return () => abort.abort();
    // пересчитываем по новому расчету, а не по каждому изменению запроса: он сам ждет расчета
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    api
      .sensitivityAll(request, abort.signal)
      .then((answer) => {
        setAnswered({ version, data: answer });
        setAllError("");
      })
      .catch((failure: Error) => {
        if (failure.name !== "AbortError") setAllError(`Не посчиталось: ${failure.message}`);
      });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, open]);

  const heads = (data?.deltas ?? []).map((delta) =>
    delta === 0 ? "как сейчас" : `${delta > 0 ? "+" : "-"}${number(Math.abs(delta) * 100, 0)}%`,
  );
  const rows = (data?.params ?? [])
    .map((param) => ({
      key: param.id,
      name: param.name,
      base: `Сейчас: ${param.base}`,
      what: param.what,
      cells: param.cells.map((cell) => {
        const outcome = cell.outcomes.find((one) => one.scenario_id === scenario);
        if (cell.baseline_tco_rub === null) {
          // объем вырос так, что парк не сходится: считать деньги не из чего
          return { key: String(cell.delta), main: "не справится", sub: "парк не сходится", bad: true, base: false };
        }
        return {
          key: String(cell.delta),
          main: term(outcome?.payback_years),
          sub: `${mln(outcome?.tco_rub ?? 0)} млн ₽, ${cell.fleet} ${plural(cell.fleet, "робот", "робота", "роботов")}`,
          bad: outcome?.payback_years == null,
          base: cell.delta === 0,
        };
      }),
    }))
    // плата за аренду покупку не меняет: строка из одинаковых чисел ничего не говорит
    .filter((row) => !(scenario === "purchase" && row.key === "raas_fee"));

  const saving = (cell: SensitivityAll["params"][number]["cells"][number] | undefined) =>
    cell?.outcomes.find((one) => one.scenario_id === scenario)?.saving_rub ?? null;
  const payback = (cell: SensitivityAll["params"][number]["cells"][number] | undefined) =>
    cell?.baseline_tco_rub === null
      ? "не справится"
      : term(cell?.outcomes.find((one) => one.scenario_id === scenario)?.payback_years);
  const strength = (param: SensitivityAll["params"][number]) =>
    (param.swings ?? []).find((one) => one.scenario_id === scenario)?.rub ?? 0;
  const moving = (all?.params ?? [])
    .filter((param) => strength(param) >= NOTICEABLE)
    .sort((a, b) => strength(b) - strength(a));
  // плата за аренду покупку не двигает: такие строки уходят к тем, что не влияют
  const flat = [
    ...(all?.flat ?? []),
    ...(all?.params ?? []).filter((param) => strength(param) < NOTICEABLE).map((param) => param.name),
  ];
  const now = saving(all?.params[0]?.cells[2]) ?? 0;
  // на сколько процентов число сдвинулось в варианте: доля 95% +20% упирается в 100%, это +5
  const moved = (values: number[], index: number) => {
    const shift = values[2] ? Math.round((values[index] / values[2] - 1) * 100) : 0;
    return shift > 0 ? `+${shift}` : String(shift);
  };
  const tornado: TornadoRow[] = moving.map((param) => {
    const values = param.cells.map(saving).filter((value): value is number => value !== null);
    const shifted = param.values ?? [];
    // сдвинулось меньше чем на 20%: доля уперлась в 100%, говорим об этом, а не молча
    const capped = shifted.length === 5 && shifted[4] < shifted[2] * 1.2 - 1e-9;
    return {
      key: param.id,
      name: param.name,
      note:
        `сейчас ${param.base}${capped ? ", выше 100% не бывает" : ""}; ` +
        `окупаемость при ${moved(shifted, 0)}%: ${payback(param.cells[0])}, при ${moved(shifted, 4)}%: ${payback(param.cells[4])}`,
      low: saving(param.cells[0]),
      high: saving(param.cells[4]),
      lowLabel: shifted.length === 5 ? moved(shifted, 0) : "-20",
      highLabel: shifted.length === 5 ? moved(shifted, 4) : "+20",
      min: Math.min(...values),
      max: Math.max(...values),
      size: `${mln(strength(param))} млн ₽`,
    };
  });

  return (
    <section id="whatif">
      <BlockHead
        title="Что будет, если..."
        note={`${scenario === "raas" ? "Аренда" : "Покупка"}: окупаемость крупно, под ней стоимость владения за ${data?.horizon_years ?? 5} лет и парк. Меняем одно число, остальные как сейчас`}
      />
      {error ? (
        <Alert>{error}</Alert>
      ) : !data ? (
        <p className="u-shift-note">Считаем варианты...</p>
      ) : (
        <div className="u-panel u-whatif-panel">
          <WhatIf heads={heads} rows={rows} />
          <div className="u-whatif-all">
            <Button kind="ghost" onClick={() => setOpen(!open)}>
              {open ? "Свернуть все числа" : "Все числа по силе влияния"}
            </Button>
            <span>
              Каждое число расчета по одному на -20% и +20%: насколько меняется выгода за {data.horizon_years} лет,
              сверху самые сильные
            </span>
          </div>
          {open &&
            (allError ? (
              <Alert>{allError}</Alert>
            ) : !all ? (
              <p className="u-shift-note">Считаем все числа...</p>
            ) : (
              <>
                <Tornado
                  rows={tornado}
                  base={now}
                  color={scenario === "raas" ? "var(--sc-rent)" : "var(--sc-buy)"}
                  heads={{
                    left: "выгода меньше",
                    center: `как сейчас: ${mln(now)} млн ₽ за ${all.horizon_years} лет`,
                    right: "больше",
                    size: "размах",
                  }}
                />
                {flat.length > 0 && (
                  <p className="u-whatif-rest">
                    <b>Итог не двигают при сдвиге до 20%:</b> {flat.join(", ")}.
                  </p>
                )}
                {all.zeros.length > 0 && (
                  <p className="u-whatif-rest">
                    <b>Равны нулю, в процентах их не сдвинуть:</b> {all.zeros.join(", ")}.
                  </p>
                )}
              </>
            ))}
        </div>
      )}
    </section>
  );
}
