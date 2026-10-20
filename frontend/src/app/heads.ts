/* Люди на экране: целыми или словами, дробью "0,2 человека" не пишем. Расчет ведется в ставках,
   здесь только как это сказать. Без импортов, проверяется без браузера: npm test */

/* Людей в смену целыми, с округлением вверх: полчеловека в смену не выйдет, 7,5 ставки это 8 человек */
export function heads(people: number): number {
  return Math.ceil(people - 1e-9);
}

export function peopleWord(count: number): string {
  const tens = count % 100;
  const last = count % 10;
  return last >= 2 && last <= 4 && (tens < 12 || tens > 14) ? "человека" : "человек";
}

/* Присмотр за роботами в смену. Обычно меньше одного человека: это часть работы начальника смены,
   пишем "доля ставки". От одного человека целыми вверх */
export function watchWords(posts: number): string {
  if (posts < 1 - 1e-9) return "доля ставки";
  const count = heads(posts);
  return `${count} ${peopleWord(count)}`;
}
