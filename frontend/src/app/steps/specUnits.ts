/* Производительность из каталога на карточке решения показываем, только если она в единицах задачи:
   паллеты для перевозки, м² для уборки. У Ronavi H1500 в каталоге 80-100 паллет в час, а на штучном
   отборе робот возит стеллажи и считается в строках: такая цифра про другую работу, ее не показываем */

// единица задачи до "/": "строк/сут" -> "строк", "м2/сут" -> "м2"
function noun(unit: string): string {
  return normalized(unit.split("/")[0] ?? "").trim();
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/м²/g, "м2");
}

export function fitsTaskUnit(specText: string, taskUnit?: string): boolean {
  if (!taskUnit) return true;
  const want = noun(taskUnit);
  return want === "" || normalized(specText).includes(want);
}
