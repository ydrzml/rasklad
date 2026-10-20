/* Готовые разборы для гостя: каждый повторяет опубликованное внедрение (docs/decisions.md, "Разборы по
   реальным кейсам"). Здесь только слова и что показать в "Что дано". Сами разборы считает сервер
   (backend/app/services/demo_cases.py) тем же расчетом, что мастер: значения кейса, план по типовой
   схеме, решение из каталога, прогон смены, способы оплаты. id те же, что там. */
import type { CaseLink, Twin } from "./twin";

export type { CaseLink } from "./twin";

export type DemoCase = {
  id: string;
  title: string;
  /* одна строка под названием: что делают роботы */
  about: string;
  operationId: string;
  robotId: string;
  robotName: string;
  /* чем меряется работа в час, для подписи тизера: один, два, пять */
  unit: [string, string, string];
  /* что роботы делают в фразе ролика: "2 робота убирают 438 м² в час" */
  verb: string;
  /* у уборки пика нет, в час идет средняя площадь: пишем "в среднем", а не "пик" */
  average?: boolean;
  /* какие значения склада и задачи показать в "Что дано": пути из /api/catalog/parameters */
  inputs: string[];
  /* реальный склад, который повторяет разбор: его параметры и факт */
  twin: Twin;
  /* сверка с кейсом: почему наш результат такой рядом с их фактом, и другие внедрения */
  real: { text: string; links: CaseLink[] };
};

const AREA = "facilities.warehouse.active_area_m2";
const SHIFTS = "facilities.warehouse.schedule.shifts";
const SHIFT_HOURS = "facilities.warehouse.schedule.shift_hours";
const OPS = "facilities.warehouse.operations";
const AUTOMACON: CaseLink = {
  title: "ВкусВилл: роботы-погрузчики и роботы-уборщики Автомакон на РЦ",
  site: "Хабр, блог Автомакона, 11.02.2025",
  href: "https://habr.com/ru/companies/automacon/articles/881120/",
};
const VOSTOK: CaseLink = {
  title: "Восток-Сервис: склад с роботами на 1С WMS, кейс интегратора",
  site: "Retail.ru, 28.06.2024",
  href: "https://www.retail.ru/cases/sklad-s-robotami-na-1s-wms-kak-gk-vostok-servis-uvelichila-skorost-komplektatsii-zakazov-v-2-5-raza/",
};

export const CASES: DemoCase[] = [
  {
    id: "pallets",
    title: "Перевозка паллет",
    about: "Роботы-погрузчики возят паллеты от ворот приемки в хранение и обратно к отгрузке",
    operationId: "pallet_transport",
    robotId: "avtomakon-ak-2000-2",
    robotName: "Автомакон AK-2000-2",
    unit: ["паллета", "паллеты", "паллет"],
    verb: "везут",
    inputs: [
      AREA,
      SHIFTS,
      SHIFT_HOURS,
      `${OPS}.pallet_transport.volume_per_day`,
      `${OPS}.pallet_transport.automatable_share`,
    ],
    twin: {
      place: "РЦ ВкусВилла",
      given: "110 000 м², 7 000 паллет в сутки, роботы везут 29% потока",
      fact: "68 погрузчиков AK-2000 на двух РЦ, за ними смотрят 3 человека в смену, окупаемость ждут за 2-3 года",
      years: [2, 3],
      compare: "purchase",
      link: AUTOMACON,
    },
    real: {
      text:
        "Режим, оклады и штат водителей ВкусВилл не публикует: они из датасета, штат пересчитан под 7 000 паллет. " +
        "Их срок это прогноз поставщика, не замер. X5 на РЦ Новая Рига с 67 погрузчиками Автомакона называет те же 2-3 года.",
      links: [
        AUTOMACON,
        {
          title: "X5 роботизировала РЦ Пятерочки: 67 погрузчиков, окупаемость 2-3 года",
          site: "Retail.ru, 04.06.2026",
          href: "https://www.retail.ru/news/kh5-robotizirovala-rts-pyatyerochki-i-pristupila-k-masshtabirovaniyu-4-iyunya-2026-278538/",
        },
      ],
    },
  },
  {
    id: "picking",
    title: "Штучный отбор",
    about: "Роботы подвозят стеллажи к станции, отборщик берет товар и больше не ходит по складу",
    operationId: "piece_picking",
    robotId: "ronavi-h1500",
    robotName: "Ronavi H1500",
    unit: ["строка", "строки", "строк"],
    verb: "подвозят стеллажи под",
    inputs: [
      AREA,
      `${OPS}.piece_picking.volume_per_day`,
      `${OPS}.piece_picking.automatable_share`,
      `${OPS}.piece_picking.productivity_before`,
      `${OPS}.piece_picking.productivity_after`,
    ],
    twin: {
      place: "склад Восток-Сервиса",
      given: "зона 7 000 м², 5 233 строки в сутки (157 тыс. в месяц), 80 комплектовщиков",
      fact: "48 роботов Ronavi H1500 и 6 станций, людей на участке меньше в 2-3 раза, окупаемость 6 месяцев при оплате за действие",
      years: [0.5, 0.5],
      compare: "raas",
      link: VOSTOK,
    },
    real: {
      text:
        "Их 6 месяцев посчитаны при оплате за действие, поэтому сравниваем с арендой. Выработку 30 строк в час до роботов " +
        "и 75 после они не публикуют: это наша оценка по их объему и штату, ускорение в 2,5 раза то же, что у интегратора. " +
        "Роботов у нас вдвое меньше: на живом объекте робот ждет у станций и в проездах, а сезонный запас 40% они берут по подписке.",
      links: [
        VOSTOK,
        {
          title: "Как работает роботизированная зона на складе Восток-Сервис",
          site: "Ronavi Robotics, кейс производителя",
          href: "https://ronavi-robotics.ru/media/kak-rabotaet-robotizirovannaya-zona-na-sklade-vostok-servis",
        },
      ],
    },
  },
  {
    id: "cleaning",
    title: "Уборка",
    about: "Робот моет проезды вместо оператора поломоечной машины",
    operationId: "cleaning",
    robotId: "avtomakon-ak-sc80",
    robotName: "Автомакон AK-SC80",
    unit: ["м²", "м²", "м²"],
    verb: "убирают",
    average: true,
    inputs: [AREA, `${OPS}.cleaning.volume_per_day`, `${OPS}.cleaning.automatable_share`],
    twin: {
      place: "РЦ ВкусВилла в Вешках",
      given: "30 000 м² уборки в сутки, робот Автомакон AK-SC80",
      fact: "2 робота AK-SC80, экономия 1 млн ₽ в год, срок окупаемости не публикуют",
      years: null,
      compare: "purchase",
      effect: true,
      link: AUTOMACON,
    },
    real: {
      text:
        "Экономия у нас та же, около 1 млн ₽ в год: робот заменяет операторов поломоечной машины подрядчика. " +
        "Но робот стоит 4 млн ₽, и даже их двое роботов за 1 млн в год окупались бы около 7 лет. Роботов у нас вдвое больше: " +
        "производитель пишет 3 000 м² в час, мы берем реальные 45% от паспорта. Лента с роботом за 2 млн ₽ называет " +
        "окупаемость до 3 лет: дешевый робот на магазин, где моют дважды в день.",
      links: [
        AUTOMACON,
        {
          title: "Робот-уборщик в Ленте: около 2 млн ₽, окупаемость не более трех лет",
          site: "Retail.ru, 02.10.2024",
          href: "https://www.retail.ru/cases/robot-uborshchik-v-lente-sotrudnik-pomoshchnik-ili-modnyy-devays/",
        },
      ],
    },
  },
];

export function caseById(id: string): DemoCase | undefined {
  return CASES.find((one) => one.id === id);
}
