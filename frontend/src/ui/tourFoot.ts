/* Кнопки внизу карточки обучения. На шаге с выбором пути карточки только выбирают, а главная
   кнопка подтверждает выбор: раньше главной была "Разберусь сам", и кто хотел обучение, жал ее и
   обучение не проходил. Отказ остается второй кнопкой рядом. */
export type TourFoot = {
  /* подпись главной кнопки */
  go: string;
  /* вторая кнопка: закрыть обучение, ничего не начиная */
  skip?: string;
};

export function tourFoot(step: { choices?: readonly unknown[]; next?: string }, last: boolean): TourFoot {
  if (step.choices?.length) return { go: "Начать обучение", skip: step.next ?? "Разберусь сам" };
  return { go: step.next ?? (last ? "Понятно" : "Дальше") };
}

/* Стрелки двигают выбор по кругу, как в группе переключателей */
export function movePick(at: number, count: number, key: string): number {
  if (count <= 0) return 0;
  if (key === "ArrowDown" || key === "ArrowRight") return (at + 1) % count;
  if (key === "ArrowUp" || key === "ArrowLeft") return (at - 1 + count) % count;
  return at;
}
