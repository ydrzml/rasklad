/* Окупаемость дольше горизонта словами (docs/decisions.md, "Срок службы и амортизация"). Сервер досчитывает
   поток до economics.later_payback_years с заменой роботов по сроку службы. Модуль без импортов, чтобы его
   брали и модули без браузера (разборы, итог шага 5): npm test */

/* Целыми годами и не меньше года после горизонта: 5,2 при горизонте 5 иначе читалось бы
   "примерно 5 лет, дольше 5 лет" */
export function aboutYears(later: number, horizon: number): string {
  const whole = Math.max(Math.round(later), horizon + 1);
  const last = whole % 10;
  const teen = whole % 100 >= 11 && whole % 100 <= 14;
  return `${whole} ${!teen && last === 1 ? "год" : !teen && last >= 2 && last <= 4 ? "года" : "лет"}`;
}

export function laterNote(horizon: number): string {
  return `дольше горизонта расчета в ${horizon} лет`;
}
