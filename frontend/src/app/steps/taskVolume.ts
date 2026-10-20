/* Объем задачи на карточке шага 1. Правка человека или разбора лежит в overrides по тому же пути,
   что читает шаг параметров и расчет, поэтому карточка показывает ее, а не значение объекта по
   умолчанию. До 20.10.2026 карточка писала 35 000 строк в сутки, когда разбор считал 5 233 */
export function volumePath(facilityId: string, taskId: string): string {
  return `facilities.${facilityId}.operations.${taskId}.volume_per_day`;
}

export function taskVolume(
  facilityId: string,
  taskId: string,
  byDefault: number,
  overrides: Record<string, number> = {},
): { value: number; edited: boolean } {
  const own = overrides[volumePath(facilityId, taskId)];
  return own === undefined ? { value: byDefault, edited: false } : { value: own, edited: own !== byDefault };
}
