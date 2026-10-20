/* Ответ на последнее нажатие главный. Новый запрос отменяет прежний (браузер не ждет его ответа),
   а если ответ прежнего все же успел прийти, он не перезаписывает новый: current() у него уже
   ложь. Так щелчки "Кредит", "Лизинг" подряд показывают цифры последнего выбора, а не того,
   что сервер досчитал позже */
export type Turn = { signal: AbortSignal; current: () => boolean };

export function latestOnly(): () => Turn {
  let last: AbortController | null = null;
  return () => {
    last?.abort();
    const mine = new AbortController();
    last = mine;
    return { signal: mine.signal, current: () => last === mine && !mine.signal.aborted };
  };
}
