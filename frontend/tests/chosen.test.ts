/* Шаг 5 по выбору человека: итог по отмеченному на шаге 4 и окно про другой способ. Запуск: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { chosen, parseMln, rangeError, years } from "../src/app/steps/chosen.ts";

// демо паллет: суммы сервера в рублях
const BASE = 256_860_000;
const BUY = { start: 41_350_000, tco: 76_910_000, payback: 1.09, effect: 37_660_000 };
const RENT = { start: 11_490_000, tco: 87_450_000, payback: 0.4, effect: 29_600_000, month: 940_000 };
const input = { horizon: 5, baselineTco: BASE, buy: BUY, rent: RENT, budget: null };

test("годы словами", () => {
  assert.equal(years(1.09), "1,1 года");
  assert.equal(years(1), "1 год");
  assert.equal(years(3), "3 года");
  assert.equal(years(5), "5 лет");
});

test("только покупка: ее цифры против людей", () => {
  const out = chosen({ ...input, wantBuy: true, wantRent: false });
  assert.equal(out.head, "Покупка окупится за 1,1 года");
  assert.match(
    out.sub,
    /^Вложить 41,4 млн ₽, экономия 37,7 млн ₽ в год\. За 5 лет дешевле, чем без роботов, на 180,0 млн ₽\.$/,
  );
  assert.equal(out.best, null);
});

test("покупка окупается дольше горизонта: примерно целыми годами, пометка первой строкой", () => {
  const slow = { ...BUY, payback: null, later: 7.3 };
  const out = chosen({ ...input, buy: slow, wantBuy: true, wantRent: false });
  assert.equal(out.head, "Покупка окупится примерно за 7 лет");
  assert.match(out.sub, /^Это дольше горизонта расчета в 5 лет\. Вложить 41,4 млн ₽/);
  // и дальше 10 лет (досчет не нашел года): просто не окупается, без срока
  const never = chosen({ ...input, buy: { ...BUY, payback: null, later: null }, wantBuy: true, wantRent: false });
  assert.equal(never.head, "Покупка не окупается");
});

test("только аренда: ее цифры против людей", () => {
  const out = chosen({ ...input, wantBuy: false, wantRent: true });
  assert.equal(out.head, "Аренда выгоднее людей с первого года");
  assert.match(out.sub, /платеж 0,9 млн ₽ в месяц/);
});

test("обе: выгоднее покупка", () => {
  const out = chosen({ ...input, wantBuy: true, wantRent: true });
  assert.equal(out.best, "buy");
  assert.equal(out.head, "Выгоднее покупка: окупится за 1,1 года");
});

test("обе дороже людей: так и говорим, выгодного не отмечаем", () => {
  const out = chosen({
    horizon: 5,
    baselineTco: 5_800_000,
    buy: { start: 2_700_000, tco: 7_200_000, payback: null, effect: 200_000 },
    rent: { start: 200_000, tco: 10_800_000, payback: null, effect: -500_000, month: 80_000 },
    wantBuy: true,
    wantRent: true,
    budget: null,
  });
  assert.equal(out.head, "Без роботов дешевле");
  assert.equal(out.best, null);
  assert.match(out.sub, /покупка на 1,4 млн ₽, аренда на 5,0 млн ₽/);
});

test("бюджет: не влезает, на грани, влезает", () => {
  const buy = { ...input, wantBuy: true, wantRent: false };
  const over = chosen({ ...buy, budget: 20_000_000, loanStart: 8_280_000 }).budget;
  assert.equal(over?.tone, "over");
  assert.equal(
    over?.text,
    "На старте нужно 41,4 млн ₽, а ваш бюджет до 20 млн ₽. Можно взять аренду: на старте 11,5 млн ₽, дальше 0,9 млн ₽ в месяц или кредит: своих денег на старте 8,3 млн ₽.",
  );
  const edge = chosen({ ...buy, budgetFrom: 30_000_000, budget: 44_000_000 }).budget;
  assert.equal(edge?.tone, "edge");
  assert.match(edge?.text ?? "", /при бюджете от 30 до 44 млн ₽: запас меньше 10%/);
  const fit = chosen({ ...buy, budgetFrom: 50_000_000, budget: 80_000_000 }).budget;
  assert.equal(fit?.tone, "fit");
  assert.match(fit?.text ?? "", /ваш бюджет от 50 до 80 млн ₽\. Это меньше, чем вы готовы вложить\.$/);
  assert.equal(chosen({ ...buy, budgetFrom: 20_000_000, budget: null }).budget?.tone, "fit");
  assert.equal(chosen({ ...buy, budget: null }).budget, null);
  assert.equal(chosen({ ...input, wantBuy: false, wantRent: true, budget: 20_000_000 }).budget, null);
});

test("бюджет не влезает: заголовок про то, что влезает", () => {
  const both = { ...input, wantBuy: true, wantRent: true, budgetFrom: 5_000_000, budget: 20_000_000 };
  const out = chosen({ ...both, loanStart: 8_280_000 });
  assert.equal(out.head, "В бюджет влезает аренда");
  assert.match(out.sub, /^Аренда: на старте 11,5 млн ₽, платеж 0,9 млн ₽ в месяц, за 5 лет дешевле, чем без роботов/);
  assert.doesNotMatch(out.head, /покупка/i);
  // кредит в заголовке, только если его отметили на шаге 4
  const credit = chosen({ ...both, loanStart: 8_280_000, leasingStart: 12_000_000, credit: true });
  assert.equal(credit.head, "В бюджет влезают аренда, кредит и лизинг");
  assert.match(credit.sub, /Кредит: своих денег на старте 8,3 млн ₽\. Лизинг: своих денег на старте 12,0 млн ₽\.$/);
  // ничего не влезает: и в плашке аренду не предлагаем
  const none = chosen({ ...both, budget: 5_000_000 });
  assert.equal(none.head, "Покупка не влезает в бюджет");
  assert.match(none.budget?.text ?? "", /Аренда тоже больше: на старте 11,5 млн ₽\.$/);
  // аренда не влезает, кредит не отмечен, но влезает только он: говорим про кредит
  const loanOnly = chosen({ ...both, budget: 10_000_000, loanStart: 8_280_000 });
  assert.equal(loanOnly.head, "В бюджет влезает кредит");
  assert.doesNotMatch(loanOnly.budget?.text ?? "", /аренду/);
  // влезает: как раньше, выгоднее покупка
  assert.match(chosen({ ...both, budget: 80_000_000 }).head, /^Выгоднее покупка/);
});

test("поля от и до: пусто можно, ноль, текст и больше границы нельзя, от не больше до", () => {
  assert.equal(parseMln(""), null);
  assert.equal(parseMln("20,5"), 20_500_000);
  assert.equal(parseMln("0"), "bad");
  assert.equal(parseMln("abc"), "bad");
  assert.equal(parseMln("20000"), "bad");
  assert.equal(rangeError("20", "50"), null);
  assert.equal(rangeError("", "50"), null);
  assert.match(rangeError("60", "50") ?? "", /больше/);
  assert.match(rangeError("-5", "") ?? "", /больше нуля/);
});

test("покупка в кредит: имя способа в заголовке, свои деньги в строке под ним", () => {
  const loan = { ...BUY, tco: 91_000_000, way: "loan" as const, own: 11_600_000 };
  const only = chosen({ ...input, buy: loan, wantBuy: true, wantRent: false });
  assert.equal(only.head, "Покупка в кредит окупится за 1,1 года");
  assert.match(only.sub, /^Своих денег на старте 11,6 млн ₽, остальное в кредит, экономия 37,7 млн ₽ в год\./);
  const both = chosen({ ...input, buy: loan, wantBuy: true, wantRent: true });
  // в кредит дороже аренды за горизонт: выгоднее аренда
  assert.equal(both.head, "Выгоднее аренда");
  const leasing = { ...BUY, way: "leasing" as const, own: 24_100_000 };
  assert.equal(
    chosen({ ...input, buy: leasing, wantBuy: true, wantRent: true }).head,
    "Выгоднее покупка в лизинг: окупится за 1,1 года",
  );
});
