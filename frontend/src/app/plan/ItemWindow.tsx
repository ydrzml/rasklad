import { useState } from "react";

import type { Direction, PlanItem, PlanSection, RackType } from "../../api/client";
import { Alert, Button, Check, FieldPair, FieldRow, Picker, Select, Window } from "../../ui";
import { number } from "../format";
import { tenth } from "./meters";
import type { Layout } from "./rows";

const NAMES: Record<string, string> = {
  racks: "Ряд стеллажей",
  dock: "Ворота",
  buffer: "Буфер у ворот",
  station: "Станция комплектации",
  charge: "Зарядка",
  blocked: "Перегородка",
  ramp: "Пандус",
  aisle: "Проезд",
  flow: "Линия движения",
};

/* У каждой вещи на плане есть число, которое она двигает. Иначе это декорация. */
export const MOVES: Record<string, string> = {
  racks:
    "Стеллажи с товаром рядами. Отсюда робот забирает груз: от рядов зависят маршрут и число проездов, верхний ярус идет в подбор",
  row: "Один ряд стеллажей там, где протянули. Толщину задает тип стеллажа, длину вы",
  aisle: "Поперечный проезд через ряды. Убирает под собой стеллажи, и робот объезжает ряды короче",
  flow: "Полоса в одну сторону. Против стрелки ехать нельзя, поперек можно. Путь туда и обратно становится разным и обычно длиннее",
  dock: "Ворота в наружной стене. Сколько ворот, столько роботов разгружаются одновременно, остальные ждут",
  buffer: "Место у ворот, куда робот ставит паллету. От буфера считаем маршрут до стеллажей",
  station: "Место, где человек берет товар со стеллажа, который привез робот. Роботы ждут у станции в очереди",
  charge: "Место, где роботы заряжаются. Его выбирает программа: у стены рядом с буфером",
  blocked: "Комната или стена: офис, холодильник, техническое помещение. Робот объезжает, маршрут удлиняется",
  nogo: "Место на полу, которым роботы не пользуются: участок людей, стоянка погрузчиков, проход персонала. Стен нет, робот объезжает",
  ramp: "Съезд между разными отметками пола. Без пандуса робот на другой уровень не попадет",
  section: "Часть здания. Тяните углы и стены. Секция сверху закрывает ту, что под ней",
  outline: "Контур здания точками: щелкайте по углам по порядку. Так обводят склад буквой Г или П",
  hole: "Вырез: здесь пола нет. Так получается двор, выступ или склад буквой Г",
};

/* Название вещи на плане. Закрытая зона это та же перегородка для робота, но без стен */
export function nameOf(item: PlanItem): string {
  return item.kind === "blocked" && item.role === "zone" ? "Закрытая зона" : (NAMES[item.kind] ?? item.kind);
}

const BLOCKS = [
  { id: "", name: "Перегородка: комната или стена" },
  { id: "zone", name: "Закрытая зона: место на полу" },
];

const WAYS: { id: Direction; name: string }[] = [
  { id: "north", name: "На север, вверх по листу" },
  { id: "south", name: "На юг, вниз по листу" },
  { id: "east", name: "На восток, вправо" },
  { id: "west", name: "На запад, влево" },
];

const ROLES = [
  { id: "receiving", name: "Приемка" },
  { id: "shipping", name: "Отгрузка" },
  { id: "both", name: "И приемка, и отгрузка" },
];

type Props = {
  item: PlanItem;
  rackTypes: RackType[];
  onChange: (patch: Partial<PlanItem>) => void;
  onClose: () => void;
};

/* Окно свойств: те же размеры, что на листе, только числами. В метр мышью не попасть,
   а с клавиатуры можно. Окно встает в колонку справа, как только вещь выбрали, кнопки «Готово»
   нет: окно закрывают крестик и Esc. Убрать объект можно из панельки над ним и клавишей Delete.
   Окно должно помещаться в колонку на экране 768 точек высотой, поэтому пары стоят в одной строке. */
export function ItemWindow({ item, onChange, onClose }: Props) {
  const num =
    (key: keyof PlanItem, least = 1) =>
    (next: string) => {
      const value = Number(next);
      if (next !== "" && Number.isFinite(value) && value >= least) onChange({ [key]: value });
    };
  const wide = item.w >= item.h;

  return (
    <Window
      title={nameOf(item)}
      about={MOVES[item.kind === "blocked" && item.role === "zone" ? "nogo" : item.kind]}
      onClose={onClose}
    >
      {item.kind === "dock" ? (
        <FieldRow
          label="Ширина ворот"
          unit="м"
          step="1"
          value={tenth(wide ? item.w : item.h)}
          onChange={(next) => {
            const value = Number(next);
            if (value >= 1) onChange(wide ? { w: value } : { h: value });
          }}
        />
      ) : (
        <FieldPair
          label="Размер"
          sep="×"
          a={{ value: tenth(item.w), onChange: num("w"), step: "1" }}
          b={{ value: tenth(item.h), onChange: num("h"), step: "1", unit: "м" }}
        />
      )}

      {item.kind === "flow" && (
        <>
          <Select
            label="Куда едут"
            value={item.direction || (wide ? "east" : "north")}
            options={WAYS}
            onChange={(direction) => onChange({ direction: direction as Direction })}
          />
          <p className="u-window-note">R разворачивает стрелку, Shift+R поворачивает на четверть</p>
        </>
      )}

      {(item.kind === "dock" || item.kind === "buffer") && (
        <Select
          label="Назначение"
          value={item.role || "both"}
          options={ROLES}
          onChange={(role) => onChange({ role })}
        />
      )}

      {item.kind === "blocked" && (
        <Select label="Что это" value={item.role} options={BLOCKS} onChange={(role) => onChange({ role })} />
      )}

      {item.kind === "charge" && (
        <Check label="место выбирает программа" checked={item.auto} onToggle={() => onChange({ auto: !item.auto })} />
      )}
    </Window>
  );
}

/* Число, которое применяется, когда его дописали: по Enter или когда ушли из поля. Пока в поле
   набирают 12, ряды не должны на мгновение схлопнуться в один. Стрелки у поля применяют сразу. */
function Settled({
  value,
  step,
  least,
  onValue,
  ...rest
}: {
  label: string;
  unit: string;
  value: number;
  step: string;
  least: number;
  hint?: string;
  onValue: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const apply = (text: string | null) => {
    setDraft(null);
    const next = Number((text ?? "").replace(",", "."));
    if (text !== null && text !== "" && Number.isFinite(next) && next >= least && next !== value) onValue(next);
  };
  return (
    <div
      className="u-settled"
      onBlur={() => apply(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") apply(draft);
      }}
    >
      <FieldRow
        {...rest}
        step={step}
        value={draft ?? value}
        onChange={(next) => {
          // шаг стрелкой у поля: применяем сразу, это не набор цифр
          if (
            Math.abs(Number(next) - value - Number(step)) < 1e-9 ||
            Math.abs(value - Number(next) - Number(step)) < 1e-9
          )
            apply(next);
          else setDraft(next);
        }}
      />
    </div>
  );
}

type Snake = { lanes: number; onSerpentine: () => void; onDropLanes: () => void };

function SnakeBar({ lanes, onSerpentine, onDropLanes }: Snake) {
  return (
    <div className="u-bar">
      <Button kind="ghost" onClick={onSerpentine}>
        {lanes ? "Змейка наоборот" : "Змейка по проездам"}
      </Button>
      {lanes > 0 && (
        <Button kind="link" onClick={onDropLanes}>
          снять змейку
        </Button>
      )}
    </div>
  );
}

/* Ряды, поставленные вместе. Число рядов, проезд и длина правятся здесь, и ряды держатся за
   верхний левый угол листа: меняется только то, что правили. Отдельный ряд выбирают двойным
   щелчком, дальше он сам по себе. */
export function GroupWindow({
  rows,
  layout,
  rackTypes,
  problem,
  onLayout,
  onChange,
  onClose,
  ...snake
}: {
  rows: PlanItem[];
  layout: Layout;
  rackTypes: RackType[];
  problem: string;
  onLayout: (change: { count?: number; aisle?: number; length?: number }) => void;
  onChange: (patch: Partial<PlanItem>) => void;
  onClose: () => void;
} & Snake) {
  const first = rows[0];
  return (
    <Window title="Ряды стеллажей" about={MOVES.racks} onClose={onClose}>
      <RackKind item={first} rackTypes={rackTypes} onChange={onChange} />
      <p className="u-window-note">Двойной щелчок по ряду выбирает его отдельно</p>
      <Settled
        label="Рядов"
        unit="шт"
        step="1"
        least={1}
        value={layout.count}
        onValue={(count) => onLayout({ count: Math.min(200, Math.round(count)) })}
      />
      <Settled
        label="Проезд между рядами"
        unit="м"
        step="0.1"
        least={0.5}
        value={tenth(layout.aisle)}
        onValue={(aisle) => onLayout({ aisle })}
      />
      <Settled
        label="Длина рядов"
        unit="м"
        step="1"
        least={2}
        value={tenth(layout.length)}
        onValue={(length) => onLayout({ length })}
      />
      {problem && <Alert>{problem}</Alert>}
      <SnakeBar {...snake} />
      <RackFields item={first} rackTypes={rackTypes} onChange={onChange} />
    </Window>
  );
}

/* Один ряд: длина держит верхний конец ряда вдоль листа и левый у ряда поперек */
export function RowWindow({
  row,
  length,
  rackTypes,
  problem,
  onLength,
  onChange,
  onGroup,
  onRemove,
  onClose,
  ...snake
}: {
  row: PlanItem;
  length: number;
  rackTypes: RackType[];
  problem: string;
  onLength: (length: number) => void;
  onChange: (patch: Partial<PlanItem>) => void;
  onGroup?: () => void;
  onRemove: () => void;
  onClose: () => void;
} & Snake) {
  return (
    <Window title="Ряд стеллажей" about={MOVES.racks} onClose={onClose}>
      <RackKind item={row} rackTypes={rackTypes} onChange={onChange} />
      <Settled label="Длина ряда" unit="м" step="1" least={1} value={tenth(length)} onValue={onLength} />
      {problem && <Alert>{problem}</Alert>}
      <RackFields item={row} rackTypes={rackTypes} onChange={onChange} />
      <SnakeBar {...snake} />
      <div className="u-bar">
        {onGroup && (
          <Button kind="link" onClick={onGroup}>
            все ряды группы
          </Button>
        )}
        <Button kind="danger" onClick={onRemove}>
          убрать ряд
        </Button>
      </div>
    </Window>
  );
}

/* Больше ярусов и рядов вплотную сервер не примет (backend/app/schemas/plan.py): дальше поле не пускает */
const MOST_TIERS = 40;

type RackProps = {
  item: PlanItem;
  rackTypes: RackType[];
  onChange: (patch: Partial<PlanItem>) => void;
};

/* Тип стеллажа первым в окне: он решает, кто работает в зоне. Тип подставляет толщину ряда,
   проезд и шаг яруса из справочника с источниками, человек их правит. Под выбором описание
   типа из config/layouts.yaml целиком, а в набивной и мобильный блок робот не заезжает. */
function RackKind({ item, rackTypes, onChange }: RackProps) {
  const kind = rackTypes.find((one) => one.id === (item.rack_type || "front"));
  const pick = (id: string) => {
    const next = rackTypes.find((one) => one.id === id);
    if (!next) return;
    // ярусов столько же по высоте, сколько было, если у типа ярусы не заданы сами
    const tiers = Math.min(
      MOST_TIERS,
      next.tiers || (item.rack_top_m > 0 ? Math.floor(item.rack_top_m / next.tier_m + 1e-6) + 1 : 0),
    );
    onChange({
      rack_type: next.id,
      row_m: next.row_m,
      block_rows: next.block_rows,
      aisle_m: next.aisle_m,
      cross_m: next.cross_m,
      tier_m: next.tier_m,
      tiers,
    });
  };
  return (
    <>
      <div className="u-frow is-pair">
        <span className="u-frow-name">Тип стеллажа</span>
        <Picker
          label="Тип стеллажа"
          value={kind?.id ?? "front"}
          options={rackTypes.map((one) => ({ id: one.id, name: one.name }))}
          onChange={pick}
        />
      </div>
      {kind && (
        <p className="u-window-note is-kind">
          {kind.about}
          {!kind.robot_inside && " Робот внутрь блока не заезжает."}
        </p>
      )}
    </>
  );
}

/* Остальные числа стеллажа. Верхний ярус не вводится: его считает сервер из числа ярусов,
   и он идет в подбор штабелеров. */
function RackFields({ item, rackTypes, onChange }: RackProps) {
  const num =
    (key: keyof PlanItem, least = 1, most = Infinity) =>
    (next: number) => {
      if (Number.isFinite(next) && next >= least) onChange({ [key]: Math.min(most, next) });
    };
  const kind = rackTypes.find((one) => one.id === (item.rack_type || "front"));
  const bands = (kind?.block_rows ?? 1) > 1 || item.block_rows > 1;
  return (
    <>
      <Settled
        label={item.rack_type === "drive_in" ? "Глубина блока" : "Толщина ряда"}
        unit="м"
        step="0.1"
        least={0.3}
        value={item.row_m}
        onValue={num("row_m", 0.3)}
      />
      {bands && (
        <Settled
          label="Рядов вплотную"
          unit=""
          step="1"
          least={1}
          value={item.block_rows}
          onValue={num("block_rows", 1, MOST_TIERS)}
        />
      )}
      {item.rack_type !== "pods" && (
        <FieldPair
          label="Ярусы"
          hint={
            <>
              верхний <span className="mono">{number(item.rack_top_m, 1)} м</span>
            </>
          }
          sep="по"
          a={{
            value: item.tiers,
            onChange: (next) =>
              Number(next) >= 1 && onChange({ tiers: Math.min(MOST_TIERS, Math.round(Number(next))) }),
            step: "1",
          }}
          b={{
            value: item.tier_m,
            onChange: (next) => Number(next) >= 0.3 && onChange({ tier_m: Number(next) }),
            step: "0.1",
            unit: "м",
          }}
        />
      )}
    </>
  );
}

/* Окно секции здания: отметка пола и потолок, а у прямоугольника еще и размер. Поднять часть
   склада значит поставить ей другую отметку пола: робот попадет туда только по пандусу.
   У контура точками размер правят на листе: углы и стены тянутся мышью. */
export function SectionWindow({
  section,
  onChange,
  onClose,
  onOutline,
  onPlain,
  problem = "",
}: {
  section: PlanSection;
  onChange: (patch: Partial<PlanSection>) => void;
  onClose: () => void;
  onOutline?: () => void;
  /* убрать обведенный контур: здание снова прямоугольник по его рамке */
  onPlain?: () => void;
  problem?: string;
}) {
  const num = (key: keyof PlanSection, least: number) => (next: string) => {
    const value = Number(next);
    if (next !== "" && Number.isFinite(value) && value >= least) onChange({ [key]: value });
  };
  const outline = (section.points?.length ?? 0) >= 3;
  return (
    <Window
      title={section.hole ? "Вырез" : outline ? "Здание" : "Секция здания"}
      about={section.hole ? MOVES.hole : MOVES.section}
      onClose={onClose}
    >
      {problem && <Alert>{problem}</Alert>}
      {outline ? (
        <p className="u-window-note">
          Контур из {section.points.length} точек, по краям{" "}
          <span className="mono">
            {number(section.w, 0)} × {number(section.h, 0)} м
          </span>
          . Тяните углы и стены на листе. Угол убирают двойным щелчком или щелчком и Del
        </p>
      ) : (
        <FieldPair
          label="Размер"
          sep="×"
          a={{ value: tenth(section.w), onChange: num("w", 2), step: "1" }}
          b={{ value: tenth(section.h), onChange: num("h", 2), step: "1", unit: "м" }}
        />
      )}
      {!section.hole && (
        <>
          <FieldRow
            label="Отметка пола"
            hint="выше нуля это антресоль или рампа, робот попадет туда только по пандусу"
            unit="м"
            step="0.1"
            value={section.floor_m}
            onChange={num("floor_m", -20)}
          />
          <FieldRow
            label="Потолок"
            hint="стеллаж выше потолка план покажет ошибкой"
            unit="м"
            step="0.5"
            value={section.ceiling_m}
            onChange={num("ceiling_m", 1)}
          />
        </>
      )}
      {onOutline && !section.hole && (
        <div className="u-bar">
          <Button kind="ghost" onClick={onOutline}>
            Обвести контур точками
          </Button>
        </div>
      )}
      {onPlain && outline && !section.hole && (
        <div className="u-bar">
          <Button kind="ghost" onClick={onPlain}>
            Убрать контур
          </Button>
        </div>
      )}
    </Window>
  );
}

/* Несколько выбранных: сколько и что можно сделать со всеми сразу. Свойства у них разные, поэтому
   полей нет, правят каждое отдельно */
export function ManyWindow({
  count,
  problem = "",
  onDuplicate,
  onRemove,
  onClose,
}: {
  count: number;
  problem?: string;
  onDuplicate: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  return (
    <Window
      title={`Выбрано: ${count}`}
      about="Тяните любой из выбранных, и поедут все. Shift+щелчок добавляет или убирает, рамка по пустому месту выбирает все, что задела"
      onClose={onClose}
    >
      {problem && <Alert>{problem}</Alert>}
      <div className="u-bar">
        <Button kind="ghost" onClick={onDuplicate}>
          Дублировать
        </Button>
        <Button kind="danger" onClick={onRemove}>
          удалить все
        </Button>
      </div>
    </Window>
  );
}
